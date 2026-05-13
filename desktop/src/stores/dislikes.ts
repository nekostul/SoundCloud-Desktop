import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { tauriStorage } from '../lib/tauri-storage';

const TRACK_URN_SEGMENT = ':tracks:';

export function isTrackUrn(urn: string): boolean {
  return typeof urn === 'string' && urn.includes(TRACK_URN_SEGMENT);
}

function sanitizeDislikedTrackUrns(urns: unknown): string[] {
  if (!Array.isArray(urns)) return [];

  return [...new Set(urns.filter((urn): urn is string => typeof urn === 'string' && isTrackUrn(urn)))];
}

interface DislikesState {
  dislikedTrackUrns: string[];
  toggleDislike: (urn: string) => void;
  pruneDislikes: (urns: string[]) => void;
  isDisliked: (urn: string) => boolean;
}

export const useDislikesStore = create<DislikesState>()(
  persist(
    (set, get) => ({
      dislikedTrackUrns: [],
      toggleDislike: (urn) => {
        if (!isTrackUrn(urn)) return;

        const { dislikedTrackUrns } = get();
        if (dislikedTrackUrns.includes(urn)) {
          set({ dislikedTrackUrns: dislikedTrackUrns.filter((u) => u !== urn) });
        } else {
          set({ dislikedTrackUrns: sanitizeDislikedTrackUrns([...dislikedTrackUrns, urn]) });
        }
      },
      pruneDislikes: (urns) => {
        if (urns.length === 0) return;

        const toRemove = new Set(urns);
        set((state) => ({
          dislikedTrackUrns: state.dislikedTrackUrns.filter((urn) => !toRemove.has(urn)),
        }));
      },
      isDisliked: (urn) => get().dislikedTrackUrns.includes(urn),
    }),
    {
      name: 'sc-dislikes',
      storage: createJSONStorage(() => tauriStorage),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<DislikesState> | undefined;

        return {
          ...currentState,
          ...persisted,
          dislikedTrackUrns: sanitizeDislikedTrackUrns(persisted?.dislikedTrackUrns),
        };
      },
    }
  )
);
