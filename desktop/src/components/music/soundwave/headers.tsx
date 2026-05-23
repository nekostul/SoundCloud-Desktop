import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from '../../../lib/icons';

const IconChip = React.memo(function IconChip({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="w-6 h-6 rounded-lg flex items-center justify-center"
      style={{
        background: 'linear-gradient(135deg, var(--color-accent-glow), rgba(255,255,255,0.05))',
        border: '1px solid var(--color-accent-glow)',
      }}
    >
      {children}
    </div>
  );
});

export const RecommendationsHeader = React.memo(function RecommendationsHeader() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 mb-3 px-1">
      <IconChip>
        <ChevronRight size={11} style={{ color: 'var(--color-accent)' }} />
      </IconChip>
      <span className="text-[12px] font-semibold text-white/80">{t('soundwave.forYou')}</span>
    </div>
  );
});
