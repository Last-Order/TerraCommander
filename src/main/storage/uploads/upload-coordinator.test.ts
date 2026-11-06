import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../../shared/storage/models';
import { StorageAccess } from '../access/storage-access';
import { StorageError } from '../core/errors';
import { deferred } from '../../testing/deferred';
import {
  byteSource,
  connectFixture,
  createTarget,
  fixtureEntry,
  fixtureRef,
  TestCheckpointStore,
} from '../testing/fixtures';
import { UploadFixtureAdapter, UploadFixtureBackend } from '../testing/upload-fixture';
import { validateCheckpoint } from './checkpoints';

async function setup(
  backend = new UploadFixtureBackend(),
  store = new TestCheckpointStore(),
  mode: 'sequential' | 'parts' = 'sequential',
  configuration: JsonObject = {},
) {
  const adapter = new UploadFixtureAdapter('connection', backend, mode);
  const { registry } = await connectFixture(adapter, configuration);
  const access = new StorageAccess(registry, store);
  return { backend, adapter, registry, store, access };
}

describe.each(['sequential', 'parts'] as const)('%s upload recovery contract', (mode) => {
  it('recovers using backend truth after rebuilding the coordinator and registry', async () => {
    const first = await setup(undefined, undefined, mode);
    const original = byteSource();
    const id = await first.access.uploads.create(createTarget(), original.source.descriptor);
    first.adapter.uploads.failBeforeCheckpoint = true;
    await expect(first.access.uploads.resume(id, original.source)).rejects.toMatchObject({
      code: 'NetworkError',
    });
    expect(validateCheckpoint(await first.store.load(id), id).progress.confirmedBytes).toBe(0);
    await first.registry.dispose();

    const next = await setup(first.backend, new TestCheckpointStore(first.store.records), mode);
    const state = await next.access.uploads.inspect(id);
    expect(state.progress.confirmedBytes).toBe(2);
    expect(JSON.stringify(state)).not.toContain('privateSessionUrl');
    const restarted = byteSource();
    const result = await next.access.uploads.resume(id, restarted.source);
    expect(result.size).toBe(6);
    const expectedOffsets = mode === 'parts' ? [0, 4] : [2, 4];
    expect(restarted.opened.map((range) => range.offset)).toEqual(expectedOffsets);
    expect((await next.access.uploads.inspect(id)).state).toBe('completed');
    expect(restarted.disposals).toBe(2);
    await next.registry.dispose();
  });

  it('reconciles a lost completion response without uploading content again', async () => {
    const fixture = await setup(undefined, undefined, mode);
    const source = byteSource();
    const id = await fixture.access.uploads.create(createTarget(), source.source.descriptor);
    fixture.adapter.uploads.loseCompletionResponse = true;
    await expect(fixture.access.uploads.resume(id, source.source)).rejects.toMatchObject({
      code: 'OutcomeUnknown',
    });
    const fresh = byteSource();
    const entry = await fixture.access.uploads.resume(id, fresh.source);
    expect(entry.size).toBe(6);
    expect(fresh.opened).toEqual([]);
    expect(fixture.adapter.uploads.calls.filter((call) => call === 'run')).toHaveLength(1);
    await expect(fixture.access.uploads.discard(id)).rejects.toMatchObject({
      code: 'PreconditionFailed',
    });
    await fixture.registry.dispose();
  });
});

describe('upload recovery guards', () => {
  it('serializes overlapping checkpoint callbacks', async () => {
    const fixture = await setup();
    const source = byteSource();
    const id = await fixture.access.uploads.create(createTarget(), source.source.descriptor);
    const started = deferred<void>();
    const release = deferred<void>();
    const saves: number[] = [];
    fixture.store.beforeSave = async (value) => {
      const checkpoint = validateCheckpoint(value, id);
      if (checkpoint.state === 'active' && checkpoint.progress.confirmedBytes > 0) {
        saves.push(checkpoint.progress.confirmedBytes);
        if (checkpoint.progress.confirmedBytes === 2) {
          started.resolve();
          await release.promise;
        }
      }
    };
    fixture.adapter.uploads.run = async (checkpoint, _source, hooks) => {
      const first = hooks.checkpoint(checkpoint, { processedBytes: 2, confirmedBytes: 2 });
      const second = hooks.checkpoint(checkpoint, { processedBytes: 4, confirmedBytes: 4 });
      await Promise.all([first, second]);
      return { ...fixtureEntry(fixtureRef('connection', 'finished')), size: 6 };
    };
    const uploading = fixture.access.uploads.resume(id, source.source);
    await started.promise;
    expect(saves).toEqual([2]);
    release.resolve();
    await uploading;
    expect(saves).toEqual([2, 4]);
    await fixture.registry.dispose();
  });
  it('persists checkpoints before allowing subsequent chunks and blocks concurrent mutations', async () => {
    const fixture = await setup();
    const source = byteSource();
    const id = await fixture.access.uploads.create(createTarget(), source.source.descriptor);
    const saving = deferred<void>();
    const release = deferred<void>();
    fixture.store.beforeSave = async (value) => {
      const checkpoint = validateCheckpoint(value, id);
      if (checkpoint.state === 'active' && checkpoint.progress.confirmedBytes === 2) {
        saving.resolve();
        await release.promise;
      }
    };
    const running = fixture.access.uploads.resume(id, source.source);
    await saving.promise;
    expect(source.opened).toHaveLength(1);
    await expect(fixture.access.uploads.inspect(id)).rejects.toMatchObject({
      code: 'PreconditionFailed',
    });
    release.resolve();
    await running;
    expect(source.opened).toHaveLength(3);
    await fixture.registry.dispose();
  });

  it('stops on a failed durable save and reconciles the accepted but unsaved bytes', async () => {
    const fixture = await setup();
    const source = byteSource();
    const id = await fixture.access.uploads.create(createTarget(), source.source.descriptor);
    let fail = true;
    fixture.store.beforeSave = async (value) => {
      const checkpoint = validateCheckpoint(value, id);
      if (checkpoint.progress.confirmedBytes === 2 && fail) {
        fail = false;
        throw new Error('private store path');
      }
    };
    await expect(fixture.access.uploads.resume(id, source.source)).rejects.toMatchObject({
      code: 'OutcomeUnknown',
    });
    expect(source.opened).toHaveLength(1);
    expect((await fixture.access.uploads.inspect(id)).progress.confirmedBytes).toBe(2);
    await fixture.access.uploads.resume(id, byteSource().source);
    await fixture.registry.dispose();
  });

  it('cleans up a session when its initial checkpoint cannot be saved', async () => {
    const fixture = await setup();
    fixture.store.beforeSave = async () => {
      throw new Error('store unavailable');
    };
    await expect(
      fixture.access.uploads.create(createTarget(), byteSource().source.descriptor),
    ).rejects.toMatchObject({ code: 'OutcomeUnknown' });
    expect(fixture.adapter.uploads.calls).toEqual(['create', 'discard']);
    expect(fixture.store.records.size).toBe(0);
    await fixture.registry.dispose();
  });

  it('suspends after cancellation and resumes from acknowledged progress', async () => {
    const fixture = await setup();
    const source = byteSource();
    const id = await fixture.access.uploads.create(createTarget(), source.source.descriptor);
    const controller = new AbortController();
    await expect(
      fixture.access.uploads.resume(id, source.source, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: 'Cancelled' });
    expect(validateCheckpoint(await fixture.store.load(id), id).state).toBe('suspended');
    const restarted = byteSource();
    await fixture.access.uploads.resume(id, restarted.source);
    expect(restarted.opened[0]?.offset).toBe(2);
    await fixture.registry.dispose();
  });

  it('rejects changed sources and weak verification without a proof callback', async () => {
    const fixture = await setup();
    const id = await fixture.access.uploads.create(createTarget(), byteSource().source.descriptor);
    const changed = byteSource('change');
    await expect(fixture.access.uploads.resume(id, changed.source)).rejects.toMatchObject({
      code: 'SourceChanged',
    });
    expect(changed.opened).toEqual([]);
    const weak = byteSource('abcdef', 'weak');
    const weakId = await fixture.access.uploads.create(createTarget(), weak.source.descriptor);
    await expect(fixture.access.uploads.resume(weakId, weak.source)).rejects.toMatchObject({
      code: 'ResumeInvalid',
    });
    weak.source.verify = vi.fn().mockResolvedValue(false);
    await expect(fixture.access.uploads.resume(weakId, weak.source)).rejects.toMatchObject({
      code: 'ResumeInvalid',
    });
    weak.source.verify = vi.fn().mockResolvedValue(true);
    await fixture.access.uploads.resume(weakId, weak.source);
    await fixture.registry.dispose();
  });

  it('validates common and private checkpoint versions without exposing payloads', async () => {
    const fixture = await setup();
    const source = byteSource();
    const id = await fixture.access.uploads.create(createTarget(), source.source.descriptor);
    const original = validateCheckpoint(await fixture.store.load(id), id);
    fixture.store.records.set(id, { ...original, version: 99 });
    await expect(fixture.access.uploads.inspect(id)).rejects.toMatchObject({
      code: 'ResumeInvalid',
    });
    fixture.store.records.set(id, { ...original, driver: { ...original.driver, version: 99 } });
    await expect(fixture.access.uploads.inspect(id)).rejects.toMatchObject({
      code: 'ResumeInvalid',
    });
    fixture.store.records.set(id, original);
    expect(JSON.stringify(await fixture.access.uploads.inspect(id))).not.toContain(
      'secret-session',
    );
    await fixture.registry.dispose();
  });

  it('binds checkpoints to connection configuration across registry reconstruction', async () => {
    const first = await setup();
    const id = await first.access.uploads.create(createTarget(), byteSource().source.descriptor);
    await first.registry.dispose();
    const next = await setup(first.backend, first.store, 'sequential', { endpoint: 'different' });
    await expect(next.access.uploads.inspect(id)).rejects.toMatchObject({ code: 'ResumeInvalid' });
    expect(next.adapter.uploads.calls).toEqual([]);
    await next.registry.dispose();
  });

  it('reports expiry and unknown outcomes without blindly continuing', async () => {
    const fixture = await setup();
    const source = byteSource();
    const id = await fixture.access.uploads.create(createTarget(), source.source.descriptor);
    const session = [...fixture.backend.sessions.values()][0]!;
    session.unknown = true;
    await expect(fixture.access.uploads.resume(id, source.source)).rejects.toMatchObject({
      code: 'OutcomeUnknown',
    });
    expect(source.opened).toEqual([]);
    session.unknown = false;
    session.expired = true;
    expect((await fixture.access.uploads.inspect(id)).state).toBe('expired');
    await expect(fixture.access.uploads.resume(id, source.source)).rejects.toMatchObject({
      code: 'ResumeExpired',
    });
    await fixture.registry.dispose();
  });

  it('discards explicitly and reports pending cleanup honestly', async () => {
    const fixture = await setup();
    const source = byteSource();
    const id = await fixture.access.uploads.create(createTarget(), source.source.descriptor);
    fixture.adapter.uploads.cleanup = 'pending';
    expect(await fixture.access.uploads.discard(id)).toEqual({ cleanup: 'pending' });
    expect((await fixture.access.uploads.inspect(id)).state).toBe('discarded');
    await expect(fixture.access.uploads.resume(id, source.source)).rejects.toMatchObject({
      code: 'ResumeInvalid',
    });
    fixture.adapter.uploads.cleanup = 'complete';
    expect(await fixture.access.uploads.discard(id)).toEqual({ cleanup: 'complete' });
    const count = fixture.adapter.uploads.calls.length;
    await fixture.access.uploads.discard(id);
    expect(fixture.adapter.uploads.calls.length).toBe(count);
    await fixture.registry.dispose();
  });

  it('requires durable recovery capability before opening an upload session', async () => {
    const fixture = await setup();
    fixture.adapter.caps.resumeWrite = { support: 'supported' };
    await expect(
      fixture.access.uploads.create(createTarget(), byteSource().source.descriptor),
    ).rejects.toBeInstanceOf(StorageError);
    expect(fixture.adapter.uploads.calls).toEqual([]);
    await fixture.registry.dispose();
  });
});
