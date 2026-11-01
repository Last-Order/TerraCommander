import { StorageAccess } from '../access/storage-access';
import { connectFixture, fixtureEntry, fixtureRef, TestCheckpointStore } from './fixtures';
import { readableAdapterContract } from './adapter-contract';

readableAdapterContract('synthetic adapter conformance', async () => {
  const { adapter, registry } = await connectFixture();
  adapter.entries = ['first-id', 'second-id'].map((locator) =>
    fixtureEntry(fixtureRef('connection', locator), 'duplicate-name'),
  );
  return {
    access: new StorageAccess(registry, new TestCheckpointStore()),
    registry,
    root: fixtureRef(),
    children: adapter.entries.map((entry) => entry.ref),
    file: adapter.entries[0]!.ref,
    content: Buffer.from('abcdef'),
  };
});
