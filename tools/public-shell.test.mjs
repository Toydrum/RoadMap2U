import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const pathOf = (relativePath) => join(root, relativePath);
const source = (relativePath) =>
  existsSync(pathOf(relativePath)) ? readFileSync(pathOf(relativePath), 'utf8') : '';

test('the public router keeps landing and account outside the lazy product shell', () => {
  const routes = source('src/app/app.routes.ts');
  assert.match(routes, /path:\s*''[\s\S]*pathMatch:\s*'full'[\s\S]*features\/landing\/landing/);
  assert.match(routes, /path:\s*'account'[\s\S]*loadChildren:[\s\S]*account\.routes/);
  assert.match(routes, /path:\s*''[\s\S]*loadChildren:[\s\S]*product\.routes/);
  assert.doesNotMatch(routes, /redirectTo:\s*'ahora'/);

  const productRoutes = source('src/app/features/shell/product.routes.ts');
  assert.match(productRoutes, /ProductShell/);
  assert.match(productRoutes, /productReadyGate/);
  for (const path of [
    'ahora',
    'check-in',
    'forest',
    'tree\/:id',
    'timer',
    'visit\/:userId',
    'settings',
    'guide',
    'trail',
    'almanaque',
    'cosecha',
  ]) {
    assert.match(productRoutes, new RegExp(`path:\\s*'${path}'`), `missing product route ${path}`);
  }
  assert.match(productRoutes, /path:\s*'\*\*'[\s\S]*redirectTo:\s*'ahora'/);
});

test('global configuration has no product initializer and defers service-worker registration', () => {
  const config = source('src/app/app.config.ts');
  assert.doesNotMatch(config, /provideAppInitializer|BootService|AuthService|SyncService/);
  assert.match(config, /productActivation\$/);
  assert.match(config, /registrationStrategy:\s*\(\)\s*=>\s*productActivation\$/);
});

test('the account route hydrates only auth and the product route owns all product startup', () => {
  const accountRoutes = source('src/app/features/shell/account.routes.ts');
  assert.match(accountRoutes, /authReadyGate/);
  assert.doesNotMatch(
    accountRoutes,
    /BootService|SyncService|Repo|Reminder|Accompaniment|ProductInitializer/,
  );

  const initializer = source('src/app/features/shell/product-initializer.ts');
  for (const service of [
    'BootService',
    'AuthInitializer',
    'SyncService',
    'ThemeService',
    'MotionService',
    'UpdateService',
    'AccompanimentService',
    'RemindersService',
    'RitualsService',
    'BackupReminderService',
  ]) {
    assert.match(initializer, new RegExp(service), `ProductInitializer does not own ${service}`);
  }
  assert.match(initializer, /markProductActive/);
});

test('the install entrypoint opens Ahora and index uses the approved favicon variants', () => {
  const manifest = JSON.parse(source('public/manifest.webmanifest'));
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/ahora');

  const index = source('src/index.html');
  assert.match(index, /href="icons\/favicon\.svg"/);
  assert.match(index, /href="icons\/favicon-32x32\.png"/);
  assert.doesNotMatch(index, /rel="icon"[^>]+href="icons\/logo\.svg"/);
});

test('account owns one accessible main landmark outside the product shell', () => {
  const account = source('src/app/features/account/account.html');
  assert.match(account, /href="#account-main"/);
  assert.match(account, /<main\s+id="account-main"\s+class="ritual">/);
  assert.doesNotMatch(account, /<div\s+class="ritual">/);
});

test('landing account and home links respect the configured base href', () => {
  const landing = source('src/app/features/landing/landing.html');
  assert.doesNotMatch(landing, /href="\/[^#"]*"/);
  assert.match(landing, /routerLink="\/"/);
  assert.match(landing, /routerLink="\/account"/);
  assert.match(landing, /routerLink="\/privacy"/);
  assert.match(landing, /routerLink="\/terms"/);
  assert.match(landing, /routerLink="\/support"/);

  const component = source('src/app/features/landing/landing.ts');
  assert.match(component, /RouterLink/);
});
