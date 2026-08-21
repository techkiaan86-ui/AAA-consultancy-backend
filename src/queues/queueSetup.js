const { Queue } = require('bullmq');
const { connection } = require('./connection');

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: true,
  removeOnFail: false, // We want to inspect failed jobs or move them to DLQ
};

let communicationsQueue, remindersQueue, noShowEnforcerQueue, paymentDripQueue, failedJobsQueue;

if (process.env.DISABLE_REDIS === 'true' || !process.env.REDIS_URL) {
  console.log('BullMQ Queues are disabled (no REDIS_URL or DISABLE_REDIS=true). Using Mock Queues.');

  class MockQueue {
    constructor(name) {
      this.name = name;
    }

    async add(name, data, opts) {
      console.log(`[Mock Queue: ${this.name}] Added job "${name}":`, JSON.stringify(data));
      return { id: `mock-job-${Date.now()}` };
    }

    async close() {
      return Promise.resolve();
    }
  }

  communicationsQueue = new MockQueue('communications');
  remindersQueue = new MockQueue('reminders');
  noShowEnforcerQueue = new MockQueue('no-show-enforcer');
  paymentDripQueue = new MockQueue('payment-drip');
  failedJobsQueue = new MockQueue('failed-jobs');
} else {
  communicationsQueue = new Queue('communications', { connection, defaultJobOptions });
  remindersQueue = new Queue('reminders', { connection, defaultJobOptions });
  noShowEnforcerQueue = new Queue('no-show-enforcer', { connection, defaultJobOptions });
  paymentDripQueue = new Queue('payment-drip', { 
    connection, 
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 5, // Payment retry more
    }
  });
  failedJobsQueue = new Queue('failed-jobs', { connection, defaultJobOptions });
}

module.exports = {
  communicationsQueue,
  remindersQueue,
  noShowEnforcerQueue,
  paymentDripQueue,
  failedJobsQueue,
};
