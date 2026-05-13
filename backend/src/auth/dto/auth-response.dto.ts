import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SetCredentialsDto {
  @ApiProperty({ description: 'SoundCloud Client ID' })
  @IsString()
  clientId: string;

  @ApiProperty({ description: 'SoundCloud Client Secret' })
  @IsString()
  clientSecret: string;

  @ApiPropertyOptional({ description: 'OAuth Redirect URI' })
  @IsOptional()
  @IsString()
  redirectUri?: string;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'SoundCloud OAuth authorization URL' })
  url: string;

  @ApiProperty({ description: 'Session ID to use for authenticated requests', format: 'uuid' })
  sessionId: string;

  @ApiProperty({ description: 'Login request ID used by /auth/login/status', format: 'uuid' })
  loginRequestId: string;
}

export class LoginStatusResponseDto {
  @ApiProperty({ enum: ['pending', 'completed', 'failed', 'expired'] })
  status: 'pending' | 'completed' | 'failed' | 'expired';

  @ApiPropertyOptional({ format: 'uuid' })
  sessionId?: string;

  @ApiPropertyOptional()
  error?: string;
}

export class SessionResponseDto {
  @ApiProperty()
  authenticated: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  sessionId?: string;

  @ApiPropertyOptional()
  username?: string;

  @ApiPropertyOptional()
  soundcloudUserId?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  expiresAt?: Date;
}

export class RefreshResponseDto {
  @ApiProperty({ format: 'uuid' })
  sessionId: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
}

export class LogoutResponseDto {
  @ApiProperty()
  success: boolean;
}
