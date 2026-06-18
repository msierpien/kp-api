import { MongoClient } from 'mongodb';
import { config } from '../config';

let client: MongoClient | null = null;
let clientPromise: Promise<MongoClient> | null = null;

export function analyticsMongoConfigured() {
  return Boolean(config.analytics.mongoUri);
}

export async function getAnalyticsMongoDb() {
  if (!config.analytics.mongoUri) {
    throw new Error('ANALYTICS_MONGO_URI is not configured');
  }

  if (client) {
    try {
      await client.db(config.analytics.mongoDb).command({ ping: 1 });
      return client.db(config.analytics.mongoDb);
    } catch (error) {
      if (!isClosedTopologyError(error)) throw error;
      await resetAnalyticsMongoClient();
    }
  }

  if (!clientPromise) {
    clientPromise = createAnalyticsMongoClient();
  }

  const connectedClient = await clientPromise;
  return connectedClient.db(config.analytics.mongoDb);
}

export async function closeAnalyticsMongo() {
  if (!client) return;
  await resetAnalyticsMongoClient();
}

function isClosedTopologyError(error: unknown) {
  return error instanceof Error && (
    error.name === 'MongoTopologyClosedError' ||
    error.message.includes('Topology is closed')
  );
}

async function createAnalyticsMongoClient() {
  const nextClient = new MongoClient(config.analytics.mongoUri as string, {
    appName: 'kp-api-competitor-analytics',
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });

  try {
    await nextClient.connect();
    client = nextClient;
    return nextClient;
  } catch (error) {
    await nextClient.close().catch(() => undefined);
    throw error;
  } finally {
    clientPromise = null;
  }
}

async function resetAnalyticsMongoClient() {
  const closedClient = client;
  client = null;
  clientPromise = null;
  await closedClient?.close().catch(() => undefined);
}
