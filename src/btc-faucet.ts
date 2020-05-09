import { RPCClient, RPCIniOptions, JSONRPC } from 'rpc-bitcoin';
import * as btc from 'bitcoinjs-lib';
import * as Bluebird from 'bluebird';
import { parsePort, time } from './helpers';
import * as coinselect from 'coinselect';

export function getFaucetPk(): string {
  const { BTC_FAUCET_PK } = process.env;
  if (!BTC_FAUCET_PK) {
    throw new Error('BTC Faucet not fully configured.');
  }
  return BTC_FAUCET_PK;
}

export function getFaucetAccount(
  network: btc.Network
): { key: btc.ECPairInterface; address: string } {
  const pkBuffer = Buffer.from(getFaucetPk(), 'hex');
  const key = btc.ECPair.fromPrivateKey(pkBuffer, { network: network });
  return { key, address: getKeyAddress(key) };
}

export function getKeyAddress(key: btc.ECPairInterface): string {
  const { address } = btc.payments.p2pkh({
    pubkey: key.publicKey,
    network: key.network,
  });
  if (!address) {
    throw new Error('address generation failed');
  }
  return address;
}

export function getRpcClient(): RPCClient {
  const { BTC_RPC_PORT, BTC_RPC_HOST, BTC_RPC_PW, BTC_RPC_USER } = process.env;
  if (!BTC_RPC_PORT || !BTC_RPC_HOST || !BTC_RPC_PW || !BTC_RPC_USER) {
    throw new Error('BTC Faucet not fully configured.');
  }
  const client = new RPCClient({
    url: BTC_RPC_HOST,
    port: parsePort(BTC_RPC_PORT),
    user: BTC_RPC_USER,
    pass: BTC_RPC_PW,
  });
  return client;
}

interface TxOutUnspent {
  amount: number;
  desc: string;
  height: number;
  scriptPubKey: string;
  txid: string;
  vout: number;
}

interface TxOutSet {
  bestblock: string;
  height: number;
  success: boolean;
  total_amount: number;
  txouts: number;
  unspents: TxOutUnspent[];
}

// Replace with client.estimatesmartfee() for testnet/mainnet
const REGTEST_FEE_RATE = 2000;

const MIN_TX_CONFIRMATIONS = 100;

function isValidBtcAddress(network: btc.Network, address: string): boolean {
  try {
    btc.address.toOutputScript(address, network);
    return true;
  } catch (error) {
    return false;
  }
}

export async function getBtcBalance(network: btc.Network, address: string) {
  if (!isValidBtcAddress(network, address)) {
    throw new Error(`Invalid BTC regtest address: ${address}`);
  }
  const client = getRpcClient();

  const txOutSet = await getTxOutSet(client, address);

  const mempoolTxIds: string[] = await time(
    () => client.getrawmempool(),
    ms => console.info(`getrawmempool took ${ms} ms`)
  );
  const mempoolTxs = await time(
    () =>
      Bluebird.mapSeries(mempoolTxIds, txid => client.getrawtransaction({ txid, verbose: true })),
    ms => console.info(`getrawtransaction for ${mempoolTxIds.length} txs took ${ms} ms`)
  );
  const mempoolBalance = mempoolTxs
    .map(tx => tx.vout)
    .flat()
    .filter(
      vout =>
        btc.address.fromOutputScript(Buffer.from(vout.scriptPubKey.hex, 'hex'), network) === address
    )
    .reduce((amount, vout) => amount + vout.value, 0);

  return txOutSet.total_amount + mempoolBalance;
}

async function getTxOutSet(client: RPCClient, address: string): Promise<TxOutSet> {
  const txOutSet: TxOutSet = await time(
    () => client.scantxoutset({ action: 'start', scanobjects: [`addr(${address})`] }),
    ms => console.info(`scantxoutset for ${address} took ${ms} ms`)
  );
  if (!txOutSet.success) {
    console.error(`WARNING: scantxoutset did not immediately complete -- polling for progress...`);
    let scanProgress = true;
    do {
      scanProgress = await client.scantxoutset({
        action: 'status',
        scanobjects: [`addr(${address})`],
      });
    } while (scanProgress);
    return getTxOutSet(client, address);
  }
  return txOutSet;
}

interface GetRawTxResult {
  txid: string;
  hex: string;
  vin: {
    txid: string;
    vout: number;
    scriptSig: {
      hex: string;
    };
  }[];
  vout: {
    n: number;
    value: number;
    addresses: string[];
    scriptPubKey: {
      hex: string;
    };
  }[];
}
interface GetRawTxResponse {
  error: string;
  result: GetRawTxResult;
}

async function getRawTransactions(client: RPCClient, txIds: string[]): Promise<GetRawTxResult[]> {
  const rawTxRequests: JSONRPC[] = txIds.map(txid => ({
    method: 'getrawtransaction',
    params: [txid, true],
  }));
  const batchRawTxRes: GetRawTxResponse[] = await time(
    () => client.batch(rawTxRequests),
    ms => console.info(`batch getrawtransaction for ${txIds.length} txs took ${ms} ms`)
  );
  return batchRawTxRes.map(t => t.result);
}

async function getSpendableUtxos(client: RPCClient, address: string): Promise<TxOutUnspent[]> {
  const txOutSet = await getTxOutSet(client, address);
  const mempoolTxIds: string[] = await time(
    () => client.getrawmempool(),
    ms => console.info(`getrawmempool took ${ms} ms`)
  );
  const rawTxs = await getRawTransactions(client, mempoolTxIds);
  const spentUtxos = rawTxs.map(tx => tx.vin).flat();
  const spendableUtxos = txOutSet.unspents.filter(
    utxo =>
      !spentUtxos.find(vin => vin.txid === utxo.txid && vin.vout === utxo.vout) &&
      txOutSet.height - utxo.height > MIN_TX_CONFIRMATIONS
  );
  return spendableUtxos;
}

export async function makeBtcFaucetPayment(
  network: btc.Network,
  address: string,
  /** Amount to send in BTC */
  faucetAmount: number
): Promise<{ txId: string; rawTx: string }> {
  if (!isValidBtcAddress(network, address)) {
    throw new Error(`Invalid BTC regtest address: ${address}`);
  }

  const client = getRpcClient();
  const faucetWallet = getFaucetAccount(network);

  const faucetAmountSats = faucetAmount * 1e8;

  const spendableUtxos = await getSpendableUtxos(client, faucetWallet.address);
  const totalSpendableAmount = spendableUtxos.reduce((amount, utxo) => amount + utxo.amount, 0);
  if (totalSpendableAmount < faucetAmount) {
    throw new Error(`not enough total amount in utxo set: ${totalSpendableAmount}`);
  }

  let minAmount = 0;
  // Typical btc transaction with 1 input and 2 outputs is around 250 bytes
  const estimatedTotalFee = 500 * REGTEST_FEE_RATE;
  const candidateUtxos = spendableUtxos.filter(utxo => {
    minAmount += utxo.amount;
    return minAmount < faucetAmount + estimatedTotalFee;
  });
  const candidateTxs = await getRawTransactions(
    client,
    candidateUtxos.map(t => t.txid)
  );
  const candidateInputs = candidateTxs.map((tx, i) => {
    const utxo = candidateUtxos[i];
    const txOut = btc.Transaction.fromHex(tx.hex).outs[utxo.vout];
    const rawTxBuffer = Buffer.from(tx.hex, 'hex');
    return {
      script: txOut.script,
      value: txOut.value,
      txRaw: rawTxBuffer,
      txId: tx.txid,
      vout: utxo.vout,
    };
  });

  const coinSelectResult = coinselect(
    candidateInputs,
    [{ address: address, value: faucetAmountSats }],
    REGTEST_FEE_RATE
  );

  const psbt = new btc.Psbt({ network: network });

  coinSelectResult.inputs.forEach(input => {
    psbt.addInput({
      hash: input.txId,
      index: input.vout,
      nonWitnessUtxo: input.txRaw,
    });
  });

  coinSelectResult.outputs.forEach(output => {
    if (!output.address) {
      // output change address
      output.address = faucetWallet.address;
    }
    psbt.addOutput({ address: output.address, value: output.value });
  });

  psbt.signAllInputs(faucetWallet.key);
  if (!psbt.validateSignaturesOfAllInputs()) {
    throw new Error('invalid pbst signature');
  }
  psbt.finalizeAllInputs();

  const tx = psbt.extractTransaction();
  const txHex = tx.toHex();
  const txId = tx.getId();
  const sendTxResult: string = await time(
    () => client.sendrawtransaction({ hexstring: txHex }),
    ms => console.info(`sendrawtransaction took ${ms}`)
  );

  if (sendTxResult !== txId) {
    throw new Error('Calculated txid does not match txid returned from RPC');
  }

  return { txId: sendTxResult, rawTx: txHex };
}
