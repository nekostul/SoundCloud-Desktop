import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccessToken } from '../common/decorators/access-token.decorator.js';
import { SessionId } from '../common/decorators/session-id.decorator.js';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { RecommendationsService } from './recommendations.service.js';

@ApiTags('recommendations')
@ApiHeader({ name: 'x-session-id', required: true })
@UseGuards(AuthGuard)
@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendationsService: RecommendationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get personalized SoundWave recommendations' })
  @ApiQuery({ name: 'limit', required: false, example: 24 })
  @ApiQuery({ name: 'mode', required: false, enum: ['similar', 'diverse'] })
  @ApiQuery({ name: 'languages', required: false, description: 'Comma-separated language codes' })
  getHome(
    @AccessToken() token: string,
    @SessionId() sessionId: string,
    @Query('limit') limit?: string,
    @Query('mode') mode?: string,
    @Query('languages') languages?: string,
  ) {
    return this.recommendationsService.getHomeRecommendations(token, sessionId, {
      limit: Number(limit),
      mode,
      languages,
    });
  }

  @Get('search')
  @ApiOperation({ summary: 'Search SoundWave recommendations by text query' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false, example: 24 })
  @ApiQuery({ name: 'languages', required: false, description: 'Comma-separated language codes' })
  search(
    @AccessToken() token: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('languages') languages?: string,
  ) {
    return this.recommendationsService.searchRecommendations(token, {
      q,
      limit: Number(limit),
      languages,
    });
  }

  @Get('similar/:trackRef')
  @ApiOperation({ summary: 'Get tracks similar to a given SoundCloud track' })
  @ApiQuery({ name: 'limit', required: false, example: 24 })
  @ApiQuery({ name: 'diversity', required: false, example: 0.35 })
  @ApiQuery({ name: 'exclude', required: false, description: 'Comma-separated track IDs to skip' })
  @ApiQuery({ name: 'languages', required: false, description: 'Comma-separated language codes' })
  getSimilar(
    @AccessToken() token: string,
    @Param('trackRef') trackRef: string,
    @Query('limit') limit?: string,
    @Query('diversity') diversity?: string,
    @Query('exclude') exclude?: string,
    @Query('languages') languages?: string,
  ) {
    return this.recommendationsService.getSimilarRecommendations(token, trackRef, {
      limit: Number(limit),
      diversity: diversity == null ? undefined : Number(diversity),
      exclude,
      languages,
    });
  }

  @Get('wave/:trackRef')
  @ApiOperation({ summary: 'Extend SoundWave from an anchor track' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'mode', required: false, enum: ['similar', 'diverse'] })
  @ApiQuery({ name: 'exclude', required: false, description: 'Comma-separated track IDs to skip' })
  @ApiQuery({
    name: 'recent',
    required: false,
    description: 'Comma-separated recent track IDs/URNs for continuity scoring',
  })
  @ApiQuery({ name: 'languages', required: false, description: 'Comma-separated language codes' })
  getWave(
    @AccessToken() token: string,
    @SessionId() sessionId: string,
    @Param('trackRef') trackRef: string,
    @Query('limit') limit?: string,
    @Query('mode') mode?: string,
    @Query('exclude') exclude?: string,
    @Query('recent') recent?: string,
    @Query('languages') languages?: string,
  ) {
    return this.recommendationsService.getWaveRecommendations(token, sessionId, trackRef, {
      limit: Number(limit),
      mode,
      exclude,
      recent,
      languages,
    });
  }
}
