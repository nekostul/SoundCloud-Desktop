import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { AxiosError } from 'axios';
import { Repository } from 'typeorm';
import { OAuthAppsService } from '../oauth-apps/oauth-apps.service.js';
import { type OAuthCredentials, SoundcloudService } from '../soundcloud/soundcloud.service.js';
import { ScMe } from '../soundcloud/soundcloud.types.js';
import { Session } from './entities/session.entity.js';

type LoginCompletionStatus = 'pending' | 'completed' | 'failed' | 'expired';
type SoundcloudAuthEntrypoint = 'pkce_authorize' | 'sdk_connect';

@Injectable()
export class AuthService {
  private static readonly LOGIN_REQUEST_TTL_MS = 15 * 60 * 1000;

  private readonly logger = new Logger(AuthService.name);
  private readonly customCredentials = new Map<string, OAuthCredentials>();

  constructor(
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    private readonly soundcloudService: SoundcloudService,
    private readonly oauthAppsService: OAuthAppsService,
    private readonly configService: ConfigService,
  ) {}

  async setCustomCredentials(
    sessionId: string | undefined,
    creds: Partial<OAuthCredentials>,
  ): Promise<void> {
    const key = sessionId || 'default';
    const normalized = this.normalizeCredentials(creds);
    this.customCredentials.set(key, normalized);

    if (this.isValidCredentials(normalized)) {
      const app = await this.oauthAppsService.upsertStandaloneLocalApp(normalized);
      this.logger.log(`Persisted runtime OAuth credentials in app "${app.name}" (${app.id})`);
    }

    this.logger.log(`Custom credentials set for key: ${key}`);
  }

  async clearCustomCredentials(
    sessionId?: string,
    options?: { clearPersisted?: boolean },
  ): Promise<void> {
    const key = sessionId || 'default';
    this.customCredentials.delete(key);

    if (key === 'default' && options?.clearPersisted !== false) {
      await this.oauthAppsService.clearStandaloneLocalApp();
    }

    this.logger.log(`Custom credentials cleared for key: ${key}`);
  }

  async initiateLogin(): Promise<{ url: string; sessionId: string; loginRequestId: string }> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(16).toString('hex');

    let oauthAppId: string | undefined;
    let creds: OAuthCredentials;

    const customCreds = this.getCustomCredentials('default');
    if (this.isValidCredentials(customCreds)) {
      const app = await this.oauthAppsService.upsertStandaloneLocalApp(customCreds);
      oauthAppId = app.id;
      creds = this.normalizeCredentials({
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        redirectUri: app.redirectUri,
      });
      this.logger.log(`Using runtime standalone OAuth app for login (${app.id})`);
    } else {
      if (customCreds) {
        await this.clearCustomCredentials('default', { clearPersisted: false });
        this.logger.warn('Ignored invalid custom credentials and cleared them');
      }

      const standaloneApp = await this.oauthAppsService.getStandaloneLocalApp();
      if (standaloneApp) {
        oauthAppId = standaloneApp.id;
        creds = this.normalizeCredentials({
          clientId: standaloneApp.clientId,
          clientSecret: standaloneApp.clientSecret,
          redirectUri: standaloneApp.redirectUri,
        });
        this.logger.log(
          `Login initiated with persisted standalone OAuth app (${standaloneApp.id})`,
        );
      } else {
        try {
          const app = this.oauthAppsService.pickRandomApp();
          oauthAppId = app.id;
          creds = this.normalizeCredentials({
            clientId: app.clientId,
            clientSecret: app.clientSecret,
            redirectUri: app.redirectUri,
          });
          this.logger.log(`Login initiated with app "${app.name}" (${app.id})`);
        } catch {
          creds = this.getEnvCredentials();
          if (!creds.clientId || !creds.clientSecret) {
            throw new NotFoundException(
              'No active OAuth apps available and env fallback is not configured',
            );
          }
          this.logger.warn('No active OAuth apps available, using env OAuth fallback');
        }
      }
    }

    const session = this.sessionRepo.create({
      codeVerifier,
      state,
      accessToken: '',
      refreshToken: '',
      expiresAt: new Date(),
      scope: '',
      oauthAppId,
      loginStatus: 'pending',
      loginError: null,
      loginCompletedAt: null,
    });
    await this.sessionRepo.save(session);

    return {
      url: this.buildLoginUrl(creds, codeChallenge, state),
      sessionId: session.id,
      loginRequestId: session.id,
    };
  }

  async handleCallback(
    code?: string,
    state?: string,
    oauthError?: string,
    errorDescription?: string,
  ): Promise<{ session: Session; success: boolean; error?: string }> {
    if (!state?.trim()) {
      throw new BadRequestException('Missing state parameter');
    }

    const session = await this.sessionRepo.findOne({ where: { state } });
    if (!session) {
      throw new BadRequestException('Invalid or expired state parameter');
    }

    if (this.isLoginRequestExpired(session)) {
      const error = 'Login request expired. Please try again.';
      return {
        session: await this.markLoginFailed(session, error, 'expired'),
        success: false,
        error,
      };
    }

    if (oauthError) {
      const error = this.buildOauthErrorMessage(oauthError, errorDescription);
      return {
        session: await this.markLoginFailed(session, error),
        success: false,
        error,
      };
    }

    if (!code?.trim()) {
      const error = 'Missing authorization code';
      return {
        session: await this.markLoginFailed(session, error),
        success: false,
        error,
      };
    }

    if (!session.codeVerifier) {
      const error = 'No code verifier found for this session';
      return {
        session: await this.markLoginFailed(session, error),
        success: false,
        error,
      };
    }

    const creds = await this.getSessionCredentials(session);

    try {
      const tokenResponse = await this.soundcloudService.exchangeCodeForToken(
        code,
        session.codeVerifier,
        creds,
      );

      session.accessToken = tokenResponse.access_token;
      session.refreshToken = tokenResponse.refresh_token;
      session.expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);
      session.scope = tokenResponse.scope || '';
      session.codeVerifier = '';
      session.state = '';
      session.loginStatus = 'completed';
      session.loginError = null;
      session.loginCompletedAt = new Date();

      try {
        const me = await this.soundcloudService.apiGet<ScMe>('/me', session.accessToken);
        session.soundcloudUserId = me.urn;
        session.username = me.username;
      } catch (meError: unknown) {
        const message = meError instanceof Error ? meError.message : String(meError);
        this.logger.warn(`OAuth login completed, but /me lookup failed: ${message}`);
      }

      await this.sessionRepo.save(session);
      return { session, success: true };
    } catch (error: unknown) {
      await this.checkAndHandleBan(error, session.oauthAppId);

      const tokenError = error as {
        response?: { data?: { error_description?: string; error?: string } };
        message?: string;
      };
      const message =
        tokenError?.response?.data?.error_description ||
        tokenError?.response?.data?.error ||
        tokenError?.message ||
        'Token exchange failed';

      return {
        session: await this.markLoginFailed(session, message),
        success: false,
        error: message,
      };
    }
  }

  async getLoginStatus(loginRequestId: string): Promise<{
    status: LoginCompletionStatus;
    sessionId?: string;
    error?: string;
  }> {
    const session = await this.sessionRepo.findOne({ where: { id: loginRequestId } });
    if (!session) {
      return { status: 'expired', error: 'Login request not found' };
    }

    if (session.loginStatus === 'completed' && session.accessToken) {
      return { status: 'completed', sessionId: session.id };
    }

    if (session.loginStatus === 'failed') {
      return {
        status: 'failed',
        sessionId: session.id,
        error: session.loginError || 'Authentication failed',
      };
    }

    if (session.loginStatus === 'expired' || this.isLoginRequestExpired(session)) {
      if (session.loginStatus !== 'expired') {
        await this.markLoginFailed(
          session,
          session.loginError || 'Login request expired. Please try again.',
          'expired',
        );
      }
      return {
        status: 'expired',
        sessionId: session.id,
        error: session.loginError || 'Login request expired',
      };
    }

    return { status: 'pending', sessionId: session.id };
  }

  async refreshSession(sessionId: string): Promise<Session> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new UnauthorizedException('Session not found');
    }

    if (!session.refreshToken) {
      throw new UnauthorizedException('No refresh token available');
    }

    const creds = await this.getSessionCredentials(session);

    try {
      const tokenResponse = await this.soundcloudService.refreshAccessToken(
        session.refreshToken,
        creds,
      );

      session.accessToken = tokenResponse.access_token;
      session.refreshToken = tokenResponse.refresh_token;
      session.expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);

      await this.sessionRepo.save(session);
      return session;
    } catch (error: unknown) {
      const isBan = await this.checkAndHandleBan(error, session.oauthAppId);

      if (!isBan) {
        await this.sessionRepo.remove(session);
        throw new UnauthorizedException(
          'Refresh token expired or invalid. Please re-authenticate.',
        );
      }

      throw new UnauthorizedException('SoundCloud app banned. Please re-authenticate.');
    }
  }

  async logout(sessionId: string): Promise<void> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) return;

    if (session.accessToken) {
      await this.soundcloudService.signOut(session.accessToken);
    }

    await this.sessionRepo.remove(session);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessionRepo.findOne({ where: { id: sessionId } });
  }

  async getValidAccessToken(sessionId: string): Promise<string> {
    let session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new UnauthorizedException('Session not found');
    }

    if (!session.accessToken) {
      throw new UnauthorizedException('Session is not authenticated');
    }

    if (session.expiresAt <= new Date()) {
      session = await this.refreshSession(sessionId);
    }

    return session.accessToken;
  }

  private isValidCredentials(creds?: Partial<OAuthCredentials> | null): creds is OAuthCredentials {
    if (!creds) return false;

    const values = [creds.clientId, creds.clientSecret, creds.redirectUri];
    return values.every((value) => {
      const normalized = String(value ?? '').trim().toLowerCase();
      return normalized !== '' && normalized !== 'undefined' && normalized !== 'null';
    });
  }

  private getCustomCredentials(key: string): OAuthCredentials | undefined {
    return this.customCredentials.get(key);
  }

  private async checkAndHandleBan(error: unknown, oauthAppId: string | null): Promise<boolean> {
    if (!oauthAppId) return false;

    if (error instanceof AxiosError && error.response) {
      const { status, data } = error.response;
      if (this.oauthAppsService.isSoundCloudAppBan(status, data)) {
        await this.oauthAppsService.markBanned(
          oauthAppId,
          `CloudFront 403 block at ${new Date().toISOString()}`,
        );
        return true;
      }
    }

    return false;
  }

  private async getSessionCredentials(session: Session): Promise<OAuthCredentials> {
    const custom = this.getCustomCredentials(session.id) || this.getCustomCredentials('default');
    if (custom) return custom;

    if (session.oauthAppId) {
      const app = await this.oauthAppsService.getById(session.oauthAppId);
      if (app) {
        return this.normalizeCredentials({
          clientId: app.clientId,
          clientSecret: app.clientSecret,
          redirectUri: app.redirectUri,
        });
      }
    }

    const standaloneApp = await this.oauthAppsService.getStandaloneLocalApp();
    if (standaloneApp) {
      return this.normalizeCredentials({
        clientId: standaloneApp.clientId,
        clientSecret: standaloneApp.clientSecret,
        redirectUri: standaloneApp.redirectUri,
      });
    }

    return this.getEnvCredentials();
  }

  private getEnvCredentials(): OAuthCredentials {
    return this.normalizeCredentials({
      clientId: this.configService.get<string>('soundcloud.clientId') || '',
      clientSecret: this.configService.get<string>('soundcloud.clientSecret') || '',
      redirectUri: this.configService.get<string>('soundcloud.redirectUri') || '',
    });
  }

  private buildLoginUrl(
    creds: OAuthCredentials,
    codeChallenge: string,
    state: string,
  ): string {
    const entrypoint = this.getAuthEntrypoint();
    const authorizeUrl =
      entrypoint === 'sdk_connect'
        ? new URL('/connect', this.soundcloudService.scConnectBaseUrl)
        : new URL('/authorize', this.soundcloudService.scAuthBaseUrl);

    authorizeUrl.searchParams.set('client_id', creds.clientId);
    authorizeUrl.searchParams.set('redirect_uri', creds.redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);

    const oauthScope = this.getOauthScope();
    if (oauthScope) {
      authorizeUrl.searchParams.set('scope', oauthScope);
    }

    if (entrypoint === 'sdk_connect') {
      authorizeUrl.searchParams.set('display', 'popup');
      authorizeUrl.searchParams.set('start_view', 'sign_in');
    }

    this.logger.log(`Generated SoundCloud auth URL via "${entrypoint}" entrypoint`);
    return authorizeUrl.toString();
  }

  private getAuthEntrypoint(): SoundcloudAuthEntrypoint {
    const configured = this.configService
      .get<string>('soundcloud.authEntrypoint')
      ?.trim()
      .toLowerCase();

    switch (configured) {
      case 'sdk_connect':
      case 'connect':
        return 'sdk_connect';
      case 'pkce_authorize':
      case 'authorize':
      case '':
      case undefined:
        return 'pkce_authorize';
      default:
        this.logger.warn(
          `Unknown SOUNDCLOUD_AUTH_ENTRYPOINT="${configured}", falling back to "pkce_authorize"`,
        );
        return 'pkce_authorize';
    }
  }

  private getOauthScope(): string {
    return this.configService.get<string>('soundcloud.oauthScope')?.trim() || '';
  }

  private normalizeCredentials(creds: Partial<OAuthCredentials>): OAuthCredentials {
    const fallbackRedirectUri =
      this.configService.get<string>('soundcloud.redirectUri')?.trim() ||
      'http://localhost:3000/auth/callback';

    return {
      clientId: String(creds.clientId ?? '').trim(),
      clientSecret: String(creds.clientSecret ?? '').trim(),
      redirectUri: String(creds.redirectUri ?? fallbackRedirectUri).trim(),
    };
  }

  private async markLoginFailed(
    session: Session,
    error: string,
    status: Exclude<LoginCompletionStatus, 'completed' | 'pending'> = 'failed',
  ): Promise<Session> {
    session.loginStatus = status;
    session.loginError = error;
    session.loginCompletedAt = null;
    session.accessToken = '';
    session.refreshToken = '';
    session.expiresAt = new Date();
    await this.sessionRepo.save(session);
    return session;
  }

  private isLoginRequestExpired(session: Session): boolean {
    return Date.now() - session.createdAt.getTime() > AuthService.LOGIN_REQUEST_TTL_MS;
  }

  private buildOauthErrorMessage(oauthError: string, errorDescription?: string): string {
    if (errorDescription?.trim()) {
      return errorDescription.trim();
    }

    switch (oauthError) {
      case 'access_denied':
        return 'SoundCloud authorization was denied';
      case 'invalid_request':
        return 'SoundCloud returned an invalid authorization request';
      default:
        return `SoundCloud OAuth error: ${oauthError}`;
    }
  }
}
