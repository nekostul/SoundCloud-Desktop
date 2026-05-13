import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module.js';
import { Session } from './auth/entities/session.entity.js';
import configuration from './config/configuration.js';
import { HealthController } from './health/health.controller.js';
import { ListeningHistory } from './history/entities/listening-history.entity.js';
import { HistoryModule } from './history/history.module.js';
import { LikesModule } from './likes/likes.module.js';
import { MeModule } from './me/me.module.js';
import { OAuthApp } from './oauth-apps/entities/oauth-app.entity.js';
import { OAuthAppsModule } from './oauth-apps/oauth-apps.module.js';
import { PlaylistsModule } from './playlists/playlists.module.js';
import { RecommendationsModule } from './recommendations/recommendations.module.js';
import { RepostsModule } from './reposts/reposts.module.js';
import { ResolveModule } from './resolve/resolve.module.js';
import { SoundcloudModule } from './soundcloud/soundcloud.module.js';
import { TracksModule } from './tracks/tracks.module.js';
import { UsersModule } from './users/users.module.js';
import { DataSource, type DataSourceOptions } from 'typeorm';

const DATABASE_ENTITIES = [Session, ListeningHistory, OAuthApp];
const ENV_FILE_PATHS = [resolve(process.cwd(), '.env'), resolve(process.cwd(), 'backend/.env')];

function createDatabaseOptions(config: ConfigService): DataSourceOptions {
  const configuredPath =
    config.get<string>('database.path')?.trim() || './data/soundcloud-desktop.sqlite';
  const databasePath = resolve(process.cwd(), configuredPath);
  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    type: 'sqljs',
    autoSave: true,
    location: databasePath,
    entities: DATABASE_ENTITIES,
    synchronize: true,
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ENV_FILE_PATHS,
      load: [configuration],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => createDatabaseOptions(config),
      dataSourceFactory: async (options) => {
        if (!options) {
          throw new Error('Database options are required');
        }

        return new DataSource(options).initialize();
      },
    }),
    OAuthAppsModule,
    AuthModule,
    SoundcloudModule,
    MeModule,
    TracksModule,
    PlaylistsModule,
    UsersModule,
    LikesModule,
    RecommendationsModule,
    RepostsModule,
    ResolveModule,
    HistoryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
