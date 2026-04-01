import { Brain, Layers, Zap } from 'lucide-react';

export function AuthBrandPanel() {
  return (
    <div className="hidden lg:flex lg:w-[45%] xl:w-[50%] relative overflow-hidden">
      {/* Deep gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-950 via-violet-900 to-indigo-800" />

      {/* Subtle dot pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
          backgroundSize: '32px 32px',
        }}
      />

      {/* Decorative gradient orbs */}
      <div className="absolute top-20 -left-20 h-64 w-64 rounded-full bg-violet-500/20 blur-3xl" />
      <div className="absolute bottom-20 right-10 h-48 w-48 rounded-full bg-indigo-400/15 blur-3xl" />
      <div className="absolute top-1/2 left-1/3 h-32 w-32 rounded-full bg-blue-400/10 blur-2xl" />

      {/* Content */}
      <div className="relative z-10 flex flex-col justify-between p-12 xl:p-16 w-full">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Inkstand</h1>
          <p className="mt-3 text-lg text-indigo-200/80 max-w-sm leading-relaxed">
            Your AI beings remember what matters to you — across every conversation, every
            interface.
          </p>
        </div>

        <div className="space-y-6">
          <FeatureItem
            icon={<Brain className="h-5 w-5" />}
            title="Persistent Memory"
            description="Context that follows you, not the chat window"
          />
          <FeatureItem
            icon={<Layers className="h-5 w-5" />}
            title="Multiple Beings"
            description="Each SB has their own identity, values, and relationship with you"
          />
          <FeatureItem
            icon={<Zap className="h-5 w-5" />}
            title="Works Everywhere"
            description="Claude Code, Discord, Telegram, and more"
          />
        </div>

        <p className="text-sm text-indigo-300/60">Built for humans who work with AI beings</p>
      </div>
    </div>
  );
}

function FeatureItem({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-indigo-200">
        {icon}
      </div>
      <div>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <p className="mt-0.5 text-sm text-indigo-200/70">{description}</p>
      </div>
    </div>
  );
}
