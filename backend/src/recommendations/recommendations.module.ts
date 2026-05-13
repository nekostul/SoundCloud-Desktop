import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { HistoryModule } from '../history/history.module.js';
import { MeModule } from '../me/me.module.js';
import { TracksModule } from '../tracks/tracks.module.js';
import { RecommendationsController } from './recommendations.controller.js';
import { RecommendationsService } from './recommendations.service.js';

@Module({
  imports: [AuthModule, TracksModule, MeModule, HistoryModule],
  controllers: [RecommendationsController],
  providers: [RecommendationsService],
})
export class RecommendationsModule {}
