'use client';

import { useCommandStore, type SkinId } from './store';
import { SKINS, getSkin } from './skins';

export function SkinPicker() {
  const currentSkin = useCommandStore((s) => s.skin);
  const setSkin = useCommandStore((s) => s.setSkin);
  const skin = getSkin(currentSkin);

  return (
    <div className="flex items-center gap-1">
      {(Object.keys(SKINS) as SkinId[]).map((id) => {
        const s = SKINS[id];
        const isActive = id === currentSkin;
        return (
          <button
            key={id}
            onClick={() => setSkin(id)}
            className="px-2 py-1 rounded text-xs transition-all"
            style={{
              backgroundColor: isActive ? skin.colors.accent + '30' : 'transparent',
              color: isActive ? skin.colors.accent : skin.colors.textMuted,
              border: isActive ? `1px solid ${skin.colors.accent}60` : '1px solid transparent',
              fontFamily: skin.fonts.body,
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
