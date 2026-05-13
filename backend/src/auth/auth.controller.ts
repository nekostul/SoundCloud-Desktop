import { Body, Controller, Get, Header, Headers, HttpCode, Post, Query } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { renderCallbackPage } from './callback-page.js';
import { AuthService } from './auth.service.js';
import {
  LoginResponseDto,
  LoginStatusResponseDto,
  LogoutResponseDto,
  RefreshResponseDto,
  SessionResponseDto,
  SetCredentialsDto,
} from './dto/auth-response.dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('credentials')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set custom OAuth credentials for this session' })
  @ApiBody({ type: SetCredentialsDto })
  @ApiHeader({ name: 'x-session-id', required: false })
  @ApiOkResponse({ description: 'Credentials set successfully' })
  async setCredentials(
    @Headers('x-session-id') sessionId: string | undefined,
    @Body() body: SetCredentialsDto,
  ) {
    await this.authService.setCustomCredentials(sessionId, {
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      redirectUri: body.redirectUri,
    });
    return { success: true };
  }

  @Post('credentials/clear')
  @HttpCode(200)
  @ApiOperation({ summary: 'Clear custom OAuth credentials for this session' })
  @ApiHeader({ name: 'x-session-id', required: false })
  @ApiOkResponse({ description: 'Credentials cleared successfully' })
  async clearCredentials(@Headers('x-session-id') sessionId: string | undefined) {
    await this.authService.clearCustomCredentials(sessionId);
    return { success: true };
  }

  @Get('login')
  @ApiOperation({ summary: 'Initiate OAuth 2.1 login flow with PKCE' })
  @ApiOkResponse({ type: LoginResponseDto })
  async login() {
    return this.authService.initiateLogin();
  }

  @Get('login/status')
  @ApiOperation({ summary: 'Poll OAuth login completion state' })
  @ApiQuery({ name: 'id', required: true, description: 'Login request ID returned by /auth/login' })
  @ApiOkResponse({ type: LoginStatusResponseDto })
  async loginStatus(@Query('id') loginRequestId: string) {
    return this.authService.getLoginStatus(loginRequestId);
  }

  @Get('callback')
  @ApiOperation({ summary: 'OAuth callback from SoundCloud' })
  @ApiQuery({ name: 'code', required: false })
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'error', required: false })
  @ApiQuery({ name: 'error_description', required: false })
  @ApiOkResponse({ description: 'HTML callback page' })
  @Header('Content-Type', 'text/html; charset=utf-8')
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') oauthError?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    try {
      const result = await this.authService.handleCallback(
        code,
        state,
        oauthError,
        errorDescription,
      );

      return renderCallbackPage({
        success: result.success,
        sessionId: result.session.id,
        username: result.session.username,
        error: result.error,
      });
    } catch (error: unknown) {
      return renderCallbackPage({
        success: false,
        error: error instanceof Error ? error.message : 'OAuth callback failed',
      });
    }
  }

  @Get('session')
  @ApiOperation({ summary: 'Get current session status' })
  @ApiHeader({ name: 'x-session-id', required: true })
  @ApiOkResponse({ type: SessionResponseDto })
  async session(@Headers('x-session-id') sessionId: string) {
    const session = await this.authService.getSession(sessionId);
    if (!session || !session.accessToken) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      sessionId: session.id,
      username: session.username,
      soundcloudUserId: session.soundcloudUserId,
      expiresAt: session.expiresAt,
    };
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiHeader({ name: 'x-session-id', required: true })
  @ApiOkResponse({ type: RefreshResponseDto })
  async refresh(@Headers('x-session-id') sessionId: string) {
    const session = await this.authService.refreshSession(sessionId);
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Logout and invalidate session' })
  @ApiHeader({ name: 'x-session-id', required: true })
  @ApiOkResponse({ type: LogoutResponseDto })
  async logout(@Headers('x-session-id') sessionId: string) {
    await this.authService.logout(sessionId);
    return { success: true };
  }
}
