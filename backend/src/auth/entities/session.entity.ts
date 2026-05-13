import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

@Entity('sessions')
export class Session {
  @PrimaryColumn({ type: 'varchar' })
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv7();
    }
  }

  @Column()
  accessToken: string;

  @Column()
  refreshToken: string;

  @Column({ type: 'datetime' })
  expiresAt: Date;

  @Column()
  scope: string;

  @Column({ nullable: true })
  soundcloudUserId: string;

  @Column({ nullable: true })
  username: string;

  @Column({ nullable: true })
  codeVerifier: string;

  @Column({ nullable: true })
  state: string;

  @Column({ nullable: true })
  oauthAppId: string;

  @Column({ default: 'pending' })
  loginStatus: string;

  @Column({ type: 'text', nullable: true })
  loginError: string | null;

  @Column({ type: 'datetime', nullable: true })
  loginCompletedAt: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date;
}
