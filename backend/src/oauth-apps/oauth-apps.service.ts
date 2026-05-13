import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { OAuthApp } from './entities/oauth-app.entity.js';

@Injectable()
export class OAuthAppsService implements OnModuleInit {
  static readonly ENV_DEFAULT_APP_NAME = 'default';
  static readonly LOCAL_STANDALONE_APP_NAME = 'standalone-local';

  private readonly logger = new Logger(OAuthAppsService.name);
  private readonly telegramBotToken: string;
  private readonly telegramChatId: string;
  private activeApps: OAuthApp[] = [];

  constructor(
    @InjectRepository(OAuthApp)
    private readonly repo: Repository<OAuthApp>,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.telegramBotToken = this.configService.get<string>('telegram.botToken') ?? '';
    this.telegramChatId = this.configService.get<string>('telegram.chatId') ?? '';
  }

  async onModuleInit() {
    await this.syncEnvDefaultApp();
    await this.reloadActiveApps();
  }

  private async syncEnvDefaultApp() {
    const clientId = this.configService.get<string>('soundcloud.clientId')?.trim() || '';
    const clientSecret = this.configService.get<string>('soundcloud.clientSecret')?.trim() || '';
    const redirectUri =
      this.configService.get<string>('soundcloud.redirectUri')?.trim() ||
      'http://localhost:3000/auth/callback';

    if (!clientId || !clientSecret) {
      return;
    }

    const defaultApp = await this.repo.findOne({
      where: { name: OAuthAppsService.ENV_DEFAULT_APP_NAME },
    });
    if (defaultApp) {
      const needsUpdate =
        defaultApp.clientId !== clientId ||
        defaultApp.clientSecret !== clientSecret ||
        defaultApp.redirectUri !== redirectUri;

      if (!needsUpdate) {
        return;
      }

      defaultApp.clientId = clientId;
      defaultApp.clientSecret = clientSecret;
      defaultApp.redirectUri = redirectUri;
      await this.repo.save(defaultApp);
      this.logger.log('Synced default OAuth app from env configuration');
      return;
    }

    const count = await this.repo.count();
    if (count > 0) {
      return;
    }

    const app = this.repo.create({
      name: OAuthAppsService.ENV_DEFAULT_APP_NAME,
      clientId,
      clientSecret,
      redirectUri,
      active: true,
    });
    await this.repo.save(app);
    this.logger.log('Migrated env OAuth credentials to oauth_apps table');
  }

  private async reloadActiveApps() {
    this.activeApps = await this.repo.find({
      where: { active: true },
      order: { createdAt: 'ASC' },
    });
    this.logger.log(`Active OAuth apps: ${this.activeApps.length}`);
  }

  pickRandomApp(): OAuthApp {
    if (this.activeApps.length === 0) {
      throw new NotFoundException('No active OAuth apps available');
    }
    const index = Math.floor(Math.random() * this.activeApps.length);
    return this.activeApps[index];
  }

  async getById(id: string): Promise<OAuthApp | null> {
    return this.repo.findOne({ where: { id } });
  }

  async getStandaloneLocalApp(): Promise<OAuthApp | null> {
    return this.repo.findOne({
      where: {
        name: OAuthAppsService.LOCAL_STANDALONE_APP_NAME,
        active: true,
      },
    });
  }

  async upsertStandaloneLocalApp(data: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<OAuthApp> {
    const clientId = data.clientId.trim();
    const clientSecret = data.clientSecret.trim();
    const redirectUri = data.redirectUri.trim();

    let app = await this.repo.findOne({
      where: { name: OAuthAppsService.LOCAL_STANDALONE_APP_NAME },
    });

    if (!app) {
      app = this.repo.create({
        name: OAuthAppsService.LOCAL_STANDALONE_APP_NAME,
        clientId,
        clientSecret,
        redirectUri,
        active: true,
        bannedAt: null,
        banReason: null,
      });
      const saved = await this.repo.save(app);
      await this.reloadActiveApps();
      this.logger.log('Created standalone-local OAuth app from runtime credentials');
      return saved;
    }

    const needsUpdate =
      app.clientId !== clientId ||
      app.clientSecret !== clientSecret ||
      app.redirectUri !== redirectUri ||
      !app.active ||
      app.bannedAt !== null ||
      app.banReason !== null;

    if (!needsUpdate) {
      return app;
    }

    app.clientId = clientId;
    app.clientSecret = clientSecret;
    app.redirectUri = redirectUri;
    app.active = true;
    app.bannedAt = null;
    app.banReason = null;

    const saved = await this.repo.save(app);
    await this.reloadActiveApps();
    this.logger.log('Updated standalone-local OAuth app from runtime credentials');
    return saved;
  }

  async clearStandaloneLocalApp(): Promise<void> {
    const app = await this.repo.findOne({
      where: { name: OAuthAppsService.LOCAL_STANDALONE_APP_NAME },
    });
    if (!app) {
      return;
    }

    await this.repo.delete(app.id);
    await this.reloadActiveApps();
    this.logger.log('Cleared standalone-local OAuth app');
  }

  async findAll(): Promise<OAuthApp[]> {
    return this.repo.find({ order: { createdAt: 'ASC' } });
  }

  async create(data: {
    name: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<OAuthApp> {
    const app = this.repo.create({ ...data, active: true });
    const saved = await this.repo.save(app);
    await this.reloadActiveApps();
    return saved;
  }

  async update(
    id: string,
    data: Partial<Pick<OAuthApp, 'name' | 'clientId' | 'clientSecret' | 'redirectUri' | 'active'>>,
  ): Promise<OAuthApp> {
    const app = await this.repo.findOne({ where: { id } });
    if (!app) throw new NotFoundException('OAuth app not found');
    Object.assign(app, data);
    const saved = await this.repo.save(app);
    await this.reloadActiveApps();
    return saved;
  }

  async remove(id: string): Promise<void> {
    await this.repo.delete(id);
    await this.reloadActiveApps();
  }

  isSoundCloudAppBan(status: number, responseBody: unknown): boolean {
    if (status !== 403) return false;

    const body = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    const lower = body.toLowerCase();

    return (
      lower.includes('request blocked') ||
      lower.includes('the request could not be satisfied') ||
      lower.includes('generated by cloudfront')
    );
  }

  async markBanned(appId: string, reason: string): Promise<void> {
    const app = await this.repo.findOne({ where: { id: appId } });
    if (!app || !app.active) return;

    app.active = false;
    app.bannedAt = new Date();
    app.banReason = reason;
    await this.repo.save(app);
    await this.reloadActiveApps();

    this.logger.warn(`OAuth app "${app.name}" (${app.id}) BANNED: ${reason}`);

    const remaining = this.activeApps.length;
    await this.sendTelegramAlert(
      `[ALERT] <b>SC App Banned</b>\n\n` +
        `App: <code>${app.name}</code>\n` +
        `Client ID: <code>${app.clientId.slice(0, 8)}...</code>\n` +
        `Reason: ${reason}\n` +
        `Remaining active: <b>${remaining}</b>\n\n` +
        (remaining === 0 ? '[WARN] <b>NO ACTIVE APPS LEFT!</b>' : ''),
    );
  }

  private async sendTelegramAlert(text: string): Promise<void> {
    if (!this.telegramBotToken || !this.telegramChatId) {
      this.logger.warn('Telegram not configured, skipping alert');
      return;
    }

    try {
      await firstValueFrom(
        this.httpService.post(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
          chat_id: this.telegramChatId,
          text,
          parse_mode: 'HTML',
        }),
      );
      this.logger.log('Telegram alert sent');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Telegram alert failed: ${message}`);
    }
  }

  async notify(text: string): Promise<void> {
    await this.sendTelegramAlert(text);
  }
}
