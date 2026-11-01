import { describe, expect, it, vi } from 'vitest';
import type { ConnectionDefinition } from '../../../shared/storage/models';
import type { AdapterServices } from '../ports/adapter';
import { StorageError } from '../core/errors';
import { deferred } from '../testing/deferred';
import { FixtureAdapter, fixtureServices } from '../testing/fixtures';
import { AdapterRegistry } from './adapter-registry';

const definition = { id: 'account', provider: 'arbitrary-provider', configuration: {} };

describe('adapter registry lifecycle', () => {
  it('accepts extensible provider keys and injects services without publishing credentials', async () => {
    const registry = new AdapterRegistry(fixtureServices);
    const adapter = new FixtureAdapter('account');
    const create = vi.fn(
      async (_definition: ConnectionDefinition, _services: AdapterServices) => adapter,
    );
    registry.register({ provider: definition.provider, create });
    await registry.connect(definition);
    const lease = await registry.acquire('account');
    expect(create.mock.calls[0]?.[1]).toBe(fixtureServices);
    expect(lease.definition).toEqual(definition);
    lease.release();
    await registry.dispose();
    expect(adapter.disposed).toBe(1);
  });

  it('reserves a connection ID while its factory is pending', async () => {
    const gate = deferred<void>();
    const registry = new AdapterRegistry(fixtureServices);
    const adapter = new FixtureAdapter('account');
    const create = vi.fn(async () => {
      await gate.promise;
      return adapter;
    });
    registry.register({ provider: definition.provider, create });
    const connecting = registry.connect(definition);
    await expect(registry.connect(definition)).rejects.toMatchObject({ code: 'AlreadyExists' });
    gate.resolve();
    await connecting;
    expect(create).toHaveBeenCalledTimes(1);
    await registry.dispose();
  });

  it('aborts pending connection creation and disposes a late adapter exactly once', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const registry = new AdapterRegistry(fixtureServices);
    const adapter = new FixtureAdapter('account');
    registry.register({
      provider: definition.provider,
      async create() {
        entered.resolve();
        await gate.promise;
        return adapter;
      },
    });
    const connecting = registry.connect(definition);
    const rejection = expect(connecting).rejects.toMatchObject({ code: 'Cancelled' });
    await entered.promise;
    const closing = registry.disconnect('account');
    gate.resolve();
    await Promise.all([rejection, closing]);
    expect(adapter.disposed).toBe(1);
    await expect(registry.acquire('account')).rejects.toMatchObject({ code: 'NotFound' });
  });

  it('waits for leases to drain and shares concurrent disconnect work', async () => {
    const registry = new AdapterRegistry(fixtureServices);
    const adapter = new FixtureAdapter('account');
    registry.register({
      provider: definition.provider,
      async create() {
        return adapter;
      },
    });
    await registry.connect(definition);
    const lease = await registry.acquire('account');
    const first = registry.disconnect('account');
    const second = registry.disconnect('account');
    await vi.waitFor(() => expect(lease.context.signal?.aborted).toBe(true));
    expect(adapter.disposed).toBe(0);
    lease.release();
    lease.release();
    await Promise.all([first, second]);
    expect(adapter.disposed).toBe(1);
  });

  it('allows reconnecting the same binding but rejects reusing an ID for another configuration', async () => {
    const registry = new AdapterRegistry(fixtureServices);
    registry.register({
      provider: definition.provider,
      async create() {
        return new FixtureAdapter('account');
      },
    });
    await registry.connect(definition);
    await registry.disconnect('account');
    await expect(
      registry.connect({ ...definition, configuration: { endpoint: 'different' } }),
    ).rejects.toMatchObject({ code: 'PreconditionFailed' });
    await registry.connect(definition);
    await registry.dispose();
  });

  it('cleans up failed factories and refuses use after disposal', async () => {
    const registry = new AdapterRegistry(fixtureServices);
    registry.register({
      provider: definition.provider,
      create: vi
        .fn()
        .mockRejectedValueOnce(new Error('secret'))
        .mockResolvedValue(new FixtureAdapter('account')),
    });
    await expect(registry.connect(definition)).rejects.toMatchObject({
      code: 'OutcomeUnknown',
      message: expect.not.stringContaining('secret'),
    });
    await registry.connect(definition);
    await registry.dispose();
    await expect(registry.acquire('account')).rejects.toBeInstanceOf(StorageError);
    expect(() =>
      registry.register({
        provider: 'new',
        async create() {
          return new FixtureAdapter('unused');
        },
      }),
    ).toThrow(StorageError);
  });
});
