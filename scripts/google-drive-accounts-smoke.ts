import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { app } from 'electron';
import { AccountError } from '../src/main/accounts/core/errors';
import { ApplicationServices } from '../src/main/services/application-services';

const [command = 'list', id] = process.argv.slice(2);
const commands = ['idle', 'infrastructure', 'list', 'add', 'verify', 'reauthorize', 'remove'];
const override = process.env.TERRACOMMANDER_SMOKE_USER_DATA;
if (!commands.includes(command) || (override && !isAbsolute(override))) {
  throw new Error('Use an account smoke command and an absolute optional data directory.');
}

const profile = override ?? join(app.getPath('appData'), 'TerraCommander Account Smoke');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setName('TerraCommander Account Smoke');
const ownsProfile = app.requestSingleInstanceLock();
const services = new ApplicationServices({ whenReady: () => app.whenReady() });
const cancellation = new AbortController();
process.once('SIGINT', () => cancellation.abort());

void app
  .whenReady()
  .then(async () => {
    if (!ownsProfile) throw new AccountError('Busy');
    const context = { signal: cancellation.signal };
    try {
      if (command === 'idle') {
        process.stdout.write('Application service owner started without using Google Drive.\n');
        return;
      }
      if (command === 'infrastructure') {
        const module = await import('./account-infrastructure-smoke');
        await module.checkAccountInfrastructure(profile);
        return;
      }
      const runtime = await services.accounts.get(context.signal);
      let result: unknown;
      switch (command) {
        case 'list':
          result = await runtime.accounts.list();
          break;
        case 'add':
          result = await runtime.accounts.add('google-drive', { method: 'browser' }, context);
          break;
        case 'verify':
        case 'reauthorize':
        case 'remove': {
          if (!id) throw new AccountError('InvalidArgument');
          if (command === 'verify') result = await runtime.accounts.verify(id, context);
          if (command === 'reauthorize')
            result = await runtime.accounts.updateAuthentication(
              id,
              { method: 'browser' },
              context,
            );
          if (command === 'remove') {
            await runtime.accounts.remove(id, context);
            result = { removed: true };
          }
          break;
        }
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await services.dispose();
    }
  })
  .catch((error: unknown) => {
    // Even a developer harness must not print SDK errors containing token request bodies.
    const failure =
      error instanceof AccountError
        ? error.toJSON()
        : { code: 'SmokeCheckFailed', message: 'The account smoke check could not finish.' };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  })
  .finally(() => app.exit(Number(process.exitCode ?? 0)));
