import {
  JsonRpcError,
  RpcStatusType,
  JsonRpc,
  IParsedObjectRequest,
  parse as parseRpcString,
  ID as JsonRpcID,
  error as jsonRpcError,
  notification as jsonRpcNotification,
  success as jsonRpcSuccess,
} from 'jsonrpc-lite';
import * as WebSocket from 'ws';
import * as http from 'http';

import { TransactionStatus } from '@blockstack/stacks-blockchain-api-types';

import { DataStore } from '../../datastore/common';
import { normalizeHashString } from '../../helpers';
import { getTxFromDataStore } from '../controllers/db-controller';

// TODO: define these in json schema
export interface TxUpdateSubscription {
  event: 'tx_update';
  tx_id: string;
}

export interface TxUpdateNotification {
  tx_id: string;
  tx_status: TransactionStatus;
}

export interface AddressTxUpdateSubscription {
  event: 'address_tx_update';
  address: string;
}

export interface AddressTxUpdateNotification {
  address: string;
  tx_id: string;
  tx_status: TransactionStatus;
}

export interface AddressBalanceSubscription {
  event: 'address_balance_update';
  address: string;
}

export interface AddressBalanceNotification {
  address: string;
  balance: string;
}

type Subscription = TxUpdateSubscription | AddressTxUpdateSubscription | AddressBalanceSubscription;

class SubscriptionManager {
  /**
   * Key = subscription topic.
   * Value = clients interested in the subscription top.
   */
  subscriptions: Map<string, Set<WebSocket>> = new Map();

  addSubscription(client: WebSocket, topicId: string) {
    let clients = this.subscriptions.get(topicId);
    if (!clients) {
      clients = new Set();
      this.subscriptions.set(topicId, clients);
    }
    clients.add(client);
    client.on('close', () => {
      this.removeSubscription(client, topicId);
    });
  }

  removeSubscription(client: WebSocket, topicId: string) {
    const clients = this.subscriptions.get(topicId);
    if (clients) {
      clients.delete(client);
      if (clients.size === 0) {
        this.subscriptions.delete(topicId);
      }
    }
  }
}

export function createWsRpcRouter(db: DataStore, server: http.Server): WebSocket.Server {
  const wsServer = new WebSocket.Server({ server, path: '/extended/v1/ws' });

  const txUpdateSubscriptions = new SubscriptionManager();
  const addressTxUpdateSubscriptions = new SubscriptionManager();
  const addressBalanceUpdateSubscriptions = new SubscriptionManager();

  function handleClientMessage(client: WebSocket, data: WebSocket.Data) {
    try {
      if (typeof data !== 'string') {
        throw JsonRpcError.parseError(`unexpected data type: ${data.constructor.name}`);
      }
      const parsedRpcReq = parseRpcString(data);
      const isBatchRequest = Array.isArray(parsedRpcReq);
      let rpcReqs = Array.isArray(parsedRpcReq) ? parsedRpcReq : [parsedRpcReq];

      // Ignore client notifications, spec dictates server should never respond to these.
      rpcReqs = rpcReqs.filter(req => req.type !== RpcStatusType.notification);

      const responses: JsonRpc[] = rpcReqs.map(rpcReq => {
        switch (rpcReq.type) {
          case RpcStatusType.request:
            return handleClientRpcReq(client, rpcReq);
          case RpcStatusType.error:
            return jsonRpcError(
              rpcReq.payload.id,
              JsonRpcError.invalidRequest('unexpected error msg from client')
            );
          case RpcStatusType.success:
            return jsonRpcError(
              rpcReq.payload.id,
              JsonRpcError.invalidRequest('unexpected success msg from client')
            );
          case RpcStatusType.invalid:
            return jsonRpcError(null as any, rpcReq.payload);
          default:
            return jsonRpcError(
              null as any,
              JsonRpcError.invalidRequest('unexpected msg type from client')
            );
        }
      });

      if (isBatchRequest) {
        client.send(JSON.stringify(responses));
      } else if (responses.length === 1) {
        client.send(responses[0].serialize());
      }
    } catch (err) {
      // Response `id` is null for invalid JSON requests (or other errors where the request ID isn't known).
      const res = err instanceof JsonRpcError ? err : JsonRpcError.internalError(err.toString());
      sendRpcResponse(client, jsonRpcError(null as any, err));
    }
  }

  function sendRpcResponse(client: WebSocket, res: JsonRpc) {
    client.send(res.serialize());
  }

  /** Route supported RPC methods */
  function handleClientRpcReq(client: WebSocket, req: IParsedObjectRequest): JsonRpc {
    switch (req.payload.method) {
      case 'subscribe':
        return handleClientSubscription(client, req, true);
      case 'unsubscribe':
        return handleClientSubscription(client, req, false);
      default:
        return jsonRpcError(req.payload.id, JsonRpcError.methodNotFound(null));
    }
  }

  /** Route supported subscription events */
  function handleClientSubscription(
    client: WebSocket,
    req: IParsedObjectRequest,
    subscribe: boolean
  ): JsonRpc {
    const params = req.payload.params as Subscription;
    if (!params || !params.event) {
      return jsonRpcError(
        req.payload.id,
        JsonRpcError.invalidParams('subscription requests must include an event name')
      );
    }
    switch (params.event) {
      case 'tx_update':
        return handleTxUpdateSubscription(client, req, params, subscribe);
      case 'address_tx_update':
        return handleAddressTxUpdateSubscription(client, req, params, subscribe);
      case 'address_balance_update':
        return handleAddressBalanceUpdateSubscription(client, req, params, subscribe);
      default:
        return jsonRpcError(
          req.payload.id,
          JsonRpcError.invalidParams('subscription request must use a valid event name')
        );
    }
  }

  /** Process client request for tx update notifications */
  function handleTxUpdateSubscription(
    client: WebSocket,
    req: IParsedObjectRequest,
    params: TxUpdateSubscription,
    subscribe: boolean
  ): JsonRpc {
    const txId = normalizeHashString(params.tx_id);
    if (!txId) {
      return jsonRpcError(req.payload.id, JsonRpcError.invalidParams('invalid tx_id'));
    }
    if (subscribe) {
      txUpdateSubscriptions.addSubscription(client, txId);
    } else {
      txUpdateSubscriptions.removeSubscription(client, txId);
    }
    return jsonRpcSuccess(req.payload.id, true);
  }

  /** Process client request for address tx update notifications */
  function handleAddressTxUpdateSubscription(
    client: WebSocket,
    req: IParsedObjectRequest,
    params: AddressTxUpdateSubscription,
    subscribe: boolean
  ): JsonRpc {
    // TODO: validate address format
    const address = params.address;
    if (subscribe) {
      addressTxUpdateSubscriptions.addSubscription(client, address);
    } else {
      addressTxUpdateSubscriptions.removeSubscription(client, address);
    }
    return jsonRpcSuccess(req.payload.id, true);
  }

  function handleAddressBalanceUpdateSubscription(
    client: WebSocket,
    req: IParsedObjectRequest,
    params: AddressBalanceSubscription,
    subscribe: boolean
  ): JsonRpc {
    // TODO: validate address format
    const address = params.address;
    if (subscribe) {
      addressBalanceUpdateSubscriptions.addSubscription(client, address);
    } else {
      addressBalanceUpdateSubscriptions.removeSubscription(client, address);
    }
    return jsonRpcSuccess(req.payload.id, true);
  }

  async function processTxUpdate(txId: string) {
    const subscribers = txUpdateSubscriptions.subscriptions.get(txId);
    if (subscribers) {
      const txData = await getTxFromDataStore(txId, db);
      if (!txData.found) {
        return;
      }
      const updateNotification: TxUpdateNotification = {
        tx_id: txId,
        tx_status: txData.result.tx_status,
      };
      const rpcNotificationPayload = jsonRpcNotification(
        'tx_update',
        updateNotification
      ).serialize();
      subscribers.forEach(client => client.send(rpcNotificationPayload));
    }
  }

  db.addListener('txUpdate', txId => {
    void processTxUpdate(txId);
  });

  wsServer.on('connection', (clientSocket, req) => {
    clientSocket.on('message', data => {
      void handleClientMessage(clientSocket, data);
    });
  });

  return wsServer;
}