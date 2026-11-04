import { Client } from 'pg';

export type SettingsTopic = { userId: string; namespace: string; key: string };
const topicKey = (topic: SettingsTopic) => JSON.stringify([topic.userId, topic.namespace, topic.key]);

/** One session connection per serving process, never a Prisma pool checkout. */
export class SettingsNotifications {
  private client?: Client;
  private connecting?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private idle?: NodeJS.Timeout;
  private stopped = false;
  private failures = 0;
  private readonly watchers = new Map<string, Set<() => void>>();

  constructor(private readonly databaseUrl: string) {}

  async subscribe(topic: SettingsTopic, changed: () => void): Promise<() => void> {
    if (this.stopped) throw new Error('Settings notifications stopped');
    if (this.idle) clearTimeout(this.idle);
    const key = topicKey(topic);
    const group = this.watchers.get(key) ?? new Set<() => void>();
    group.add(changed);
    this.watchers.set(key, group);
    const unsubscribe = () => {
      group.delete(changed);
      if (!group.size) this.watchers.delete(key);
      if (!this.watchers.size) {
        this.idle = setTimeout(() => { void this.disconnect(); }, 60_000);
        this.idle.unref();
      }
    };
    try { await this.connect(); } catch (error) { unsubscribe(); throw error; }
    return unsubscribe;
  }

  private connect(): Promise<void> {
    if (this.stopped || !this.watchers.size) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.client) return Promise.resolve();
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const url = new URL(this.databaseUrl);
    const socketDirectory = url.searchParams.get('host');
    for (const key of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer']) url.searchParams.delete(key);
    const client = new Client({ connectionString: url.toString(), ...(socketDirectory ? { host: socketDirectory } : {}),
      connectionTimeoutMillis: 5000, keepAlive: true, application_name: 'uoa-settings-listener' });
    client.on('notification', notification => {
      if (notification.channel !== 'uoa_settings_changed' || !notification.payload) return;
      try {
        const topic = JSON.parse(notification.payload) as SettingsTopic;
        if (typeof topic.userId !== 'string' || typeof topic.namespace !== 'string' || typeof topic.key !== 'string') return;
        this.watchers.get(topicKey(topic))?.forEach(callback => callback());
      } catch { /* An invalid hint never authorizes a read. */ }
    });
    let failed = false;
    const disconnected = () => {
      if (failed) return;
      failed = true;
      if (this.client === client) this.client = undefined;
      void client.end().catch(() => {});
      this.scheduleReconnect();
    };
    client.on('error', disconnected);
    client.on('end', disconnected);
    try {
      await client.connect();
      await client.query('LISTEN uoa_settings_changed');
      if (this.stopped || failed) throw new Error('Settings listener unavailable');
      this.client = client;
      this.failures = 0;
      // LISTEN completes before reading snapshots, including after reconnect.
      this.watchers.forEach(group => group.forEach(callback => callback()));
    } catch (error) {
      disconnected();
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry || !this.watchers.size) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)) + Math.random() * 1000;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
    this.retry.unref();
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    await client?.end().catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watchers.clear();
    if (this.idle) clearTimeout(this.idle);
    await this.connecting?.catch(() => {});
    await this.disconnect();
  }
}
