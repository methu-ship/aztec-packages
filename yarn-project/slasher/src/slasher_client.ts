import {
  type ExtendedViemWalletClient,
  type L1ReaderConfig,
  L1TxUtils,
  RollupContract,
  SlashingProposerContract,
} from '@aztec/ethereum';
import { EthAddress } from '@aztec/foundation/eth-address';
import { createLogger } from '@aztec/foundation/log';
import { SlashFactoryAbi } from '@aztec/l1-artifacts';
import type { L2BlockId } from '@aztec/stdlib/block';

// import { type TelemetryClient, WithTracer, getTelemetryClient } from '@aztec/telemetry-client';
import {
  type GetContractEventsReturnType,
  type GetContractReturnType,
  type WatchEventReturnType,
  encodeFunctionData,
  getAddress,
  getContract,
} from 'viem';

// import { TelemetryClient, WithTracer, getTelemetryClient } from '@aztec/telemetry-client';
import {
  Offence,
  type SlasherConfig,
  WANT_TO_SLASH_EVENT,
  type WantToSlashArgs,
  type Watcher,
  bigIntToOffence,
} from './config.js';

/**
 * Enum defining the possible states of the Slasher client.
 */
export enum SlasherClientState {
  IDLE,
  RUNNING,
  STOPPED,
}

/**
 * The synchronization status of the Slasher client.
 */
export interface SlasherSyncState {
  /**
   * The current state of the slasher client.
   */
  state: SlasherClientState;
  /**
   * The block number that the slasher client is synced to.
   */
  syncedToL2Block: L2BlockId;
}

// Renamed from SlashEvent and updated for new event structure
type MonitoredSlashPayload = {
  payloadAddress: EthAddress;
  validators: readonly EthAddress[];
  amounts: readonly bigint[];
  offenses: readonly Offence[];
  // For TTL management, using L1 block number when event was seen
  // Alternatively, could be a timestamp if preferred and L1 gives us reliable timestamps.
  // slotNumber seems to map to L2 slots, L1 event monitoring will give L1 blockNumber.
  observedAtL1BlockNumber: bigint;
  // The 'lifetime' concept from the old SlashEvent (calculated based on slashingRoundSize)
  // might still be relevant for deciding *when* to vote within a round,
  // distinct from the overall TTL of the payload.
  // For now, focusing on the new fields. The old lifetime was related to which slot it should be active for.
  totalAmount: bigint;
};

/**
 * @notice A Hypomeiones slasher client implementation
 *
 * Hypomeiones: a class of individuals in ancient Sparta who were considered inferior or lesser citizens compared
 * to the full Spartan citizens.
 *
 * How it works:
 *
 * The constructor creates instances of classes that correspond to specific offences. These "watchers" do two things:
 * - watch for their offence conditions and emit an event when they are detected
 * - confirm/deny whether they agree with a proposed offence
 *
 * The SlasherClient class is responsible for:
 * - listening for events from the watchers and creating a corresponding payload
 * - listening for the payloads from L1 filtering them through the watchers
 * - ordering the payloads and discarding stale payloads
 * - presenting the payload that ought to be currently voted for
 *
 *
 *
 * A few improvements:
 * - Only vote on the proposal if it is possible to reach, e.g., if 6 votes are needed and only 4 slots are left don't vote.
 * - Stop voting on a payload once it is processed.
 * - Only vote on the proposal if it have not already been executed
 *  - Caveat, we need to fully decide if it is acceptable to have the same payload address multiple times. In the current
 *    slash factory that could mean slashing the same committee for the same error multiple times.
 * - Decide how to deal with multiple slashing events in the same round.
 *  - This could be that multiple epochs are pruned in the same round, but with the current naive implementation we could end up
 *    slashing only the first, because the "lifetime" of the second would have passed after that vote
 */
export class SlasherClient {
  private monitoredPayloads: MonitoredSlashPayload[] = [];

  private unwatchExecutableListener: WatchEventReturnType | undefined;
  private unwatchSlashFactoryEvents: WatchEventReturnType | undefined;

  static async new(
    config: SlasherConfig,
    l1Contracts: Pick<L1ReaderConfig['l1Contracts'], 'rollupAddress' | 'slashFactoryAddress'>,
    l1TxUtils: L1TxUtils,
    watchers: Watcher[],
    // telemetry: TelemetryClient = getTelemetryClient(),
  ) {
    if (!l1Contracts.slashFactoryAddress) {
      throw new Error('Cannot initialize SlasherClient without a slashFactory address');
    }

    const rollup = new RollupContract(l1TxUtils.client, l1Contracts.rollupAddress);
    const slashingProposer = await rollup.getSlashingProposer();
    const slashFactoryContract = getContract({
      address: getAddress(l1Contracts.slashFactoryAddress.toString()),
      abi: SlashFactoryAbi,
      client: l1TxUtils.client,
    });
    return new SlasherClient(config, slashFactoryContract, slashingProposer, l1TxUtils, watchers);
  }

  constructor(
    public config: SlasherConfig,
    protected slashFactoryContract: GetContractReturnType<typeof SlashFactoryAbi, ExtendedViemWalletClient>,
    private slashingProposer: SlashingProposerContract,
    private l1TxUtils: L1TxUtils,
    private watchers: Watcher[],
    // telemetry: TelemetryClient = getTelemetryClient(),
    private log = createLogger('slasher'),
  ) {
    // super(telemetry, 'slasher');
  }

  public start() {
    this.log.info('Starting Slasher client...');

    this.unwatchExecutableListener = this.slashingProposer.listenToExecutableProposals(
      this.executeRoundIfAgree.bind(this),
    );

    this.watchSlashFactoryEvents();
    this.watchers.forEach(watcher => watcher.on(WANT_TO_SLASH_EVENT, this.wantToSlash.bind(this)));
  }

  public wantToSlash(args: WantToSlashArgs) {
    this.log.info('Wants to slash', args);
    this.l1TxUtils
      .sendAndMonitorTransaction({
        to: this.slashFactoryContract.address,
        data: encodeFunctionData({
          abi: SlashFactoryAbi,
          functionName: 'createSlashPayload',
          args: [args.validators, args.amounts, args.offenses.map(offense => BigInt(offense))],
        }),
      })
      // note, we don't need to monitor the logs here,
      // it is handled by watchSlashFactoryEvents
      .catch(e => {
        this.log.error('Error slashing', e);
      });
  }

  private *factoryEventsToMonitoredPayloads(
    args: GetContractEventsReturnType<typeof SlashFactoryAbi, 'SlashPayloadCreated'>,
  ): IterableIterator<MonitoredSlashPayload> {
    for (const event of args) {
      if (!event.args) {
        continue;
      }
      const args = event.args;
      if (!args.payloadAddress || !args.validators || !args.amounts || !args.offences) {
        continue;
      }
      yield {
        payloadAddress: EthAddress.fromString(args.payloadAddress),
        validators: args.validators.map(EthAddress.fromString),
        amounts: args.amounts,
        offenses: args.offences.map(offense => bigIntToOffence(offense)),
        observedAtL1BlockNumber: event.blockNumber,
        totalAmount: args.amounts.reduce((acc, amount) => acc + amount, BigInt(0)),
      };
    }
  }

  private sortMonitoredPayloads() {
    // sort by total amount in descending order
    this.monitoredPayloads.sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount));
  }

  private async addMonitoredPayload(payload: MonitoredSlashPayload) {
    if (await this.doIAgreeWithPayload(payload)) {
      this.log.info('Adding monitored payload', payload);
      this.monitoredPayloads.push(payload);
    } else {
      this.log.info('Disagreeing with payload', payload);
    }
  }

  private filterExpiredPayloads(currentL1Block: bigint, payloadTtlSlots: bigint) {
    // filter out payloads that have expired
    // or we disagree with

    // TODO: check on race condition with sortMonitoredPayloads here
    this.monitoredPayloads = this.monitoredPayloads.filter(payload => {
      return payload.observedAtL1BlockNumber + payloadTtlSlots > currentL1Block;
    });
  }

  /**
   * Allows consumers to stop the instance of the slasher client.
   * 'ready' will now return 'false' and the running promise that keeps the client synced is interrupted.
   */
  public stop() {
    this.log.debug('Stopping Slasher client...');
    if (this.unwatchSlashFactoryEvents) {
      this.unwatchSlashFactoryEvents();
    }
    if (this.unwatchExecutableListener) {
      this.unwatchExecutableListener();
    }
    // this.epochPruneWatcher.stop();
    this.log.info('Slasher client stopped.');
  }

  private watchSlashFactoryEvents() {
    this.unwatchSlashFactoryEvents = this.slashFactoryContract.watchEvent.SlashPayloadCreated({
      onLogs: logs => {
        for (const payload of this.factoryEventsToMonitoredPayloads(logs)) {
          this.log.info('Slash payload created', payload);
          this.addMonitoredPayload(payload).catch(e => {
            this.log.error('Error adding monitored payload', e);
          });
        }
        this.sortMonitoredPayloads();
      },
    });
  }

  private async doIAgreeWithPayload(payload: MonitoredSlashPayload) {
    // zip offenses and validators together
    const offensesAndValidators = payload.offenses.map((offense, index) => ({
      offense,
      validator: payload.validators[index],
      amount: payload.amounts[index],
    }));

    // check each offense
    for (const offenseAndValidator of offensesAndValidators) {
      const watcherResponses = await Promise.all(
        this.watchers.map(watcher =>
          watcher.shouldSlash(
            offenseAndValidator.validator.toString(),
            offenseAndValidator.amount,
            offenseAndValidator.offense,
          ),
        ),
      );
      // if no watcher agrees, return false
      if (watcherResponses.every(response => !response)) {
        return false;
      }
    }
    return true;
  }

  public async getSlashPayload(_slotNumber: bigint): Promise<EthAddress | undefined> {
    if (this.config.slashOverridePayload && !this.config.slashOverridePayload.isZero()) {
      this.log.info(`Overriding slash payload to: ${this.config.slashOverridePayload.toString()}`);
      return Promise.resolve(this.config.slashOverridePayload);
    }

    const currentL1Block = await this.l1TxUtils.client.getBlockNumber();
    this.filterExpiredPayloads(currentL1Block, BigInt(this.config.slashPayloadTtlSlots));

    if (this.monitoredPayloads.length === 0) {
      this.log.debug('No monitored payloads, returning undefined');
      return Promise.resolve(undefined);
    }

    const selectedPayload = this.monitoredPayloads[0];
    this.log.info('selectedPayload', selectedPayload);

    return Promise.resolve(selectedPayload.payloadAddress);
  }

  public getMonitoredPayloads(): MonitoredSlashPayload[] {
    return this.monitoredPayloads;
  }

  public removeFirstMatchingPayload(payload: EthAddress) {
    const index = this.monitoredPayloads.findIndex(p => p.payloadAddress.equals(payload));
    if (index === -1) {
      return;
    }
    this.monitoredPayloads.splice(index, 1);
  }

  public async executeRoundIfAgree({ proposal, round }: { proposal: `0x{string}`; round: bigint }) {
    const payload = EthAddress.fromString(proposal);
    if (!this.monitoredPayloads.find(p => p.payloadAddress.equals(payload))) {
      this.log.debug('Round executable, but we disagree', { proposal, round });
      return;
    }

    await this.slashingProposer
      .executeRound(this.l1TxUtils, round)
      .then(() => {
        this.removeFirstMatchingPayload(payload);
      })
      .catch(reason => {
        this.log.warn('Could not execute round', reason);
      });
  }
}
