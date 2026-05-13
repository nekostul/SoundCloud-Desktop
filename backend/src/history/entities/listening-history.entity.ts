import { BeforeInsert, Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

@Entity('listening_history')
export class ListeningHistory {
  @PrimaryColumn({ type: 'varchar' })
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv7();
    }
  }

  @Index()
  @Column()
  soundcloudUserId: string;

  @Column()
  scTrackId: string;

  @Column()
  title: string;

  @Column()
  artistName: string;

  @Column({ nullable: true })
  artworkUrl: string;

  @Column({ type: 'int' })
  duration: number;

  @CreateDateColumn({ type: 'datetime' })
  playedAt: Date;
}
