import { loadDotEnv, timeout, logger, logError, isProdEnv } from './helpers';
import { DataStore } from './datastore/common';
import { PgDataStore } from './datastore/postgres-store';
import { MemoryDataStore } from './datastore/memory-store';
import { startApiServer } from './api/init';
import { startEventServer } from './event-stream/event-server';
import { StacksCoreRpcClient } from './core-rpc/client';
import * as WebSocket from 'ws';
import { createMiddleware as createPrometheusMiddleware } from '@promster/express';
import { createServer as createPrometheusServer } from '@promster/server';
import { ChainID } from '@stacks/transactions';

loadDotEnv();

async function monitorCoreRpcConnection(): Promise<void> {
  const CORE_RPC_HEARTBEAT_INTERVAL = 5000; // 5 seconds
  let previouslyConnected = false;
  while (true) {
    const client = new StacksCoreRpcClient();
    try {
      await client.waitForConnection();
      if (!previouslyConnected) {
        logger.info(`Connection to Stacks core node API server at: ${client.endpoint}`);
      }
      previouslyConnected = true;
    } catch (error) {
      previouslyConnected = false;
      logger.error(`Warning: failed to connect to node RPC server at ${client.endpoint}`);
    }
    await timeout(CORE_RPC_HEARTBEAT_INTERVAL);
  }
}

async function getCoreChainID(): Promise<ChainID> {
  const client = new StacksCoreRpcClient();
  await client.waitForConnection(Infinity);
  const coreInfo = await client.getInfo();
  if (coreInfo.network_id === ChainID.Mainnet) {
    return ChainID.Mainnet;
  } else if (coreInfo.network_id === ChainID.Testnet) {
    return ChainID.Testnet;
  } else {
    throw new Error(`Unexpected network_id "${coreInfo.network_id}"`);
  }
}

async function init(): Promise<void> {
  let db: DataStore;
  switch (process.env['STACKS_BLOCKCHAIN_API_DB']) {
    case 'memory': {
      logger.info('using in-memory db');
      db = new MemoryDataStore();
      break;
    }
    case 'pg':
    case undefined: {
      db = await PgDataStore.connect();
      break;
    }
    default: {
      throw new Error(
        `Invalid STACKS_BLOCKCHAIN_API_DB option: "${process.env['STACKS_BLOCKCHAIN_API_DB']}"`
      );
    }
  }

  const promMiddleware = isProdEnv ? createPrometheusMiddleware() : undefined;
  await startEventServer({ db, promMiddleware });
  monitorCoreRpcConnection().catch(error => {
    logger.error(`Error monitoring RPC connection: ${error}`, error);
  });
  const networkChainId = await getCoreChainID();
  const apiServer = await startApiServer(db, networkChainId, promMiddleware);
  logger.info(`API server listening on: http://${apiServer.address}`);

  if (isProdEnv) {
    await createPrometheusServer({ port: 9153 });
    logger.info(`@promster/server started on port 9153.`);
  }
}

init()
  .then(() => {
    logger.info('App initialized');
  })
  .catch(error => {
    logError(`app failed to start: ${error}`, error);
    process.exit(1);
  });
