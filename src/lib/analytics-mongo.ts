import { MongoClient } from 'mongodb';
import { config } from '../config';

let client: MongoClient | null = null;

export function analyticsMongoConfigured() {
  return Boolean(config.analytics.mongoUri);
}

export async function getAnalyticsMongoDb() {
  if (!config.analytics.mongoUri) {
    throw new Error('ANALYTICS_MONGO_URI is not configured');
  }

  if (!client) {
    client = new MongoClient(config.analytics.mongoUri, {
      appName: 'kp-api-competitor-analytics',
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
  }

  return client.db(config.analytics.mongoDb);
}

export async function closeAnalyticsMongo() {
  if (!client) return;
  await client.close();
  client = null;
}
