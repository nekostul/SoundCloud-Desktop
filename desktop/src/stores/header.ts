import { create } from 'zustand';

type HeaderState = {
  compactHeaderVisible: boolean;
  setCompactHeaderVisible: (visible: boolean) => void;
};

export const useHeaderState = create<HeaderState>((set) => ({
  compactHeaderVisible: false,
  setCompactHeaderVisible: (visible: boolean) => set({ compactHeaderVisible: visible }),
}));
