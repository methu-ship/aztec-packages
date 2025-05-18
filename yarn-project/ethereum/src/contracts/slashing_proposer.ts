import { EthAddress } from '@aztec/foundation/eth-address';
import { SlashingProposerAbi } from '@aztec/l1-artifacts/SlashingProposerAbi';

import EventEmitter from 'node:events';
import { type GetContractReturnType, type Hex, encodeFunctionData, getContract } from 'viem';

import type { L1TxRequest, L1TxUtils } from '../l1_tx_utils.js';
import type { ViemClient } from '../types.js';
import { type IEmpireBase, encodeVote } from './empire_base.js';

export class SlashingProposerContract extends EventEmitter implements IEmpireBase {
  private readonly proposer: GetContractReturnType<typeof SlashingProposerAbi, ViemClient>;

  constructor(public readonly client: ViemClient, address: Hex) {
    super();
    this.proposer = getContract({ address, abi: SlashingProposerAbi, client });
  }

  public get address() {
    return EthAddress.fromString(this.proposer.address);
  }

  public getQuorumSize() {
    return this.proposer.read.N();
  }

  public getRoundSize() {
    return this.proposer.read.M();
  }

  public computeRound(slot: bigint): Promise<bigint> {
    return this.proposer.read.computeRound([slot]);
  }

  public async getRoundInfo(
    rollupAddress: Hex,
    round: bigint,
  ): Promise<{ lastVote: bigint; leader: Hex; executed: boolean }> {
    const roundInfo = await this.proposer.read.rounds([rollupAddress, round]);
    return {
      lastVote: roundInfo[0],
      leader: roundInfo[1],
      executed: roundInfo[2],
    };
  }

  public getProposalVotes(rollupAddress: Hex, round: bigint, proposal: Hex): Promise<bigint> {
    return this.proposer.read.yeaCount([rollupAddress, round, proposal]);
  }

  public createVoteRequest(payload: Hex): L1TxRequest {
    return {
      to: this.address.toString(),
      data: encodeVote(payload),
    };
  }

  public listenToExecutableProposals(callback: (args: { proposal: `0x{string}`; round: bigint }) => unknown) {
    return this.proposer.watchEvent.ProposalExecutable(
      {},
      {
        onLogs: logs => {
          for (const payload of logs) {
            const args = payload.args;
            if (args.proposal && args.round) {
              // why compiler can't figure it out? no one knows
              callback(args as any);
            }
          }
        },
      },
    );
  }

  public executeRound(txUtils: L1TxUtils, round: bigint | number) {
    if (typeof round === 'number') {
      round = BigInt(round);
    }
    return txUtils.sendAndMonitorTransaction({
      to: this.address.toString(),
      data: encodeFunctionData({
        abi: SlashingProposerAbi,
        functionName: 'executeProposal',
        args: [round],
      }),
    });
  }
}
