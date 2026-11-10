import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transactionConflictCode,
  isTransactionTimeout,
  withTransactionRetry
} from '../../packages/db/src/transaction-retry.ts';

test('recognizes direct SQLSTATE/Prisma conflicts and nested adapter causes without parsing messages', () => {
  for (const code of ['40P01', '40001', 'P2034']) {
    assert.equal(transactionConflictCode({ code }), code);
    assert.equal(
      transactionConflictCode({ meta: { driverAdapterError: { cause: { originalCode: code } } } }),
      code
    );
  }
  assert.equal(transactionConflictCode(new Error('deadlock 40P01')), null);
  assert.equal(transactionConflictCode({ code: 'P2002' }), null);
  assert.equal(transactionConflictCode({ message: '40001' }), null);
});

test('hostile properties, cycles and excessive wrapping are bounded', () => {
  const cycle = {};
  cycle.cause = cycle;
  assert.equal(transactionConflictCode(cycle), null);
  assert.equal(
    transactionConflictCode({
      get code() {
        throw Error('must not escape');
      }
    }),
    null
  );
  let wrapped = { code: '40001' };
  for (let i = 0; i < 20; i++) wrapped = { cause: wrapped };
  assert.equal(transactionConflictCode(wrapped), null);
  assert.equal(transactionConflictCode(null), null);
});

test('default and explicitly unsafe actions execute only once even on conflicts', async () => {
  for (const options of [undefined, { replaySafe: false }]) {
    let calls = 0;
    const original = { code: '40001' };
    await assert.rejects(
      withTransactionRetry(async () => {
        calls++;
        throw original;
      }, options),
      (error) => error === original
    );
    assert.equal(calls, 1);
  }
});

test('whole-transaction replay opens a fresh attempt with trusted state and bounded random waits', async () => {
  let calls = 0;
  let trustedVersion = 0;
  const waits = [];
  const result = await withTransactionRetry(
    async () => {
      const version = trustedVersion;
      calls++;
      if (calls < 3) throw { code: calls === 1 ? '40P01' : 'P2034' };
      return version;
    },
    {
      replaySafe: true,
      jitter: (upper) => upper - 1,
      wait: async (ms) => {
        waits.push(ms);
        trustedVersion++;
      }
    }
  );
  assert.equal(calls, 3);
  assert.equal(result, 2);
  assert.deepEqual(waits, [39, 79]);
});

test('exhausted conflicts propagate the original final error after at most two extra attempts', async () => {
  let calls = 0;
  let waits = 0;
  let last;
  await assert.rejects(
    withTransactionRetry(
      async () => {
        last = { code: '40001', attempt: ++calls };
        throw last;
      },
      {
        replaySafe: true,
        jitter: () => 0,
        wait: async () => {
          waits++;
        }
      }
    ),
    (error) => error === last
  );
  assert.equal(calls, 3);
  assert.equal(waits, 2);
});

test('timeout and unrelated errors are never replayed, including wrapped P2028', async () => {
  for (const original of [
    { code: 'P2028' },
    { code: 'P2002' },
    { code: 'ECONNRESET' },
    new Error('x'),
    { code: 'P2034', cause: { code: 'P2028' } }
  ]) {
    let calls = 0;
    await assert.rejects(
      withTransactionRetry(
        async () => {
          calls++;
          throw original;
        },
        {
          replaySafe: true,
          wait: async () => assert.fail('must not wait')
        }
      ),
      (error) => error === original
    );
    assert.equal(calls, 1);
  }
  assert.equal(isTransactionTimeout({ meta: { driverAdapterError: { cause: { code: 'P2028' } } } }), true);
});

test('invalid injected backoff does not mask the conflict or invoke unbounded waits', async () => {
  let calls = 0;
  const error = { code: '40P01' };
  await assert.rejects(
    withTransactionRetry(
      async () => {
        calls++;
        throw error;
      },
      {
        replaySafe: true,
        jitter: () => Infinity,
        wait: async () => assert.fail('must not wait')
      }
    ),
    (actual) => actual === error
  );
  assert.equal(calls, 1);
});

test('success including business-error values is returned without replay', async () => {
  const returned = { businessError: 'EXPIRED' };
  let calls = 0;
  assert.equal(
    await withTransactionRetry(
      async () => {
        calls++;
        return returned;
      },
      { replaySafe: true }
    ),
    returned
  );
  assert.equal(calls, 1);
});
