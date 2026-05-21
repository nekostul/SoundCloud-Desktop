import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { LyricLine } from '../lib/lyrics';
import { tauriStorage } from '../lib/tauri-storage';

export type CommunityLyricsDraftSource = 'genius' | 'soundcloud';

export interface CommunityLyricsDraft {
  trackUrn: string;
  artistName: string;
  trackName: string;
  durationSec: number;
  plainLyrics: string;
  syncedLyrics: LyricLine[];
  createdAt: string;
  source: CommunityLyricsDraftSource;
}

interface CommunityLyricsDraftStore {
  draftsByTrackUrn: Record<string, CommunityLyricsDraft>;
  saveDraft: (draft: CommunityLyricsDraft) => void;
  removeDraft: (trackUrn: string) => void;
}

export const useCommunityLyricsDraftStore = create<CommunityLyricsDraftStore>()(
  persist(
    (set) => ({
      draftsByTrackUrn: {},
      saveDraft: (draft) =>
        set((state) => ({
          draftsByTrackUrn: {
            ...state.draftsByTrackUrn,
            [draft.trackUrn]: draft,
          },
        })),
      removeDraft: (trackUrn) =>
        set((state) => {
          if (!state.draftsByTrackUrn[trackUrn]) {
            return state;
          }

          const next = { ...state.draftsByTrackUrn };
          delete next[trackUrn];

          return {
            draftsByTrackUrn: next,
          };
        }),
    }),
    {
      name: 'community-lyrics-drafts',
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        draftsByTrackUrn: state.draftsByTrackUrn,
      }),
    },
  ),
);
