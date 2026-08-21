const { Redis } = require('ioredis');
require('dotenv').config();

let connection;

if (process.env.DISABLE_REDIS === 'true' || !process.env.REDIS_URL) {
  console.log('Redis is disabled or REDIS_URL is missing. Using Mock Redis.');

  class MockRedis {
    constructor() {
      this.store = {};
    }

    on(event, callback) {
      // No-op for events
      return this;
    }

    async get(key) {
      return this.store[key] || null;
    }

    async set(key, value, ...args) {
      this.store[key] = value;
      return 'OK';
    }

    async del(key) {
      delete this.store[key];
      return 1;
    }

    async quit() {
      return 'OK';
    }

    async disconnect() {
      return 'OK';
    }
  }

  connection = new MockRedis();
} else {
  connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null, // Required by BullMQ
    retryStrategy(times) {
      // Wait at least 2 seconds, up to 10 seconds before retrying, to avoid terminal spam
      return Math.min(times * 2000, 10000);
    },
  });

  connection.on('error', (err) => {
    console.error('Redis connection error:', err);
  });
}

module.exports = { connection };
