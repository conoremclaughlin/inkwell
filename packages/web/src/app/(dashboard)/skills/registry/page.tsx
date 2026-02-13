'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Puzzle,
  Terminal,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Search,
  Code,
  BookOpen,
  Download,
  Star,
  Users,
  ArrowLeft,
  ExternalLink,
} from 'lucide-react';
import { useApiQuery, apiPost, apiDelete } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import Link from 'next/link';

type SkillType = 'mini-app' | 'cli' | 'guide';

interface RegistrySkill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: SkillType;
  category: string | null;
  tags: string[];
  emoji: string | null;
  currentVersion: string;
  author: string | null;
  isOfficial: boolean;
  isVerified: boolean;
  installCount: number;
  isInstalled?: boolean;
}

interface RegistryResponse {
  skills: RegistrySkill[];
  total: number;
  categories: string[];
}

const typeConfig: Record<
  SkillType,
  { label: string; icon: React.ReactNode; color: string; bgColor: string }
> = {
  'mini-app': {
    label: 'Mini App',
    icon: <Code className="h-4 w-4" />,
    color: 'text-purple-600',
    bgColor: 'bg-purple-100',
  },
  cli: {
    label: 'CLI Tool',
    icon: <Terminal className="h-4 w-4" />,
    color: 'text-blue-600',
    bgColor: 'bg-blue-100',
  },
  guide: {
    label: 'Guide',
    icon: <BookOpen className="h-4 w-4" />,
    color: 'text-green-600',
    bgColor: 'bg-green-100',
  },
};

export default function SkillsRegistryPage() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);

  const buildUrl = () => {
    const params = new URLSearchParams();
    if (searchQuery) params.set('search', searchQuery);
    if (selectedCategory) params.set('category', selectedCategory);
    const query = params.toString();
    return `/api/admin/skills/registry${query ? `?${query}` : ''}`;
  };

  const { data, isLoading, error, refetch } = useApiQuery<RegistryResponse>(
    ['skills-registry', searchQuery, selectedCategory],
    buildUrl()
  );

  const skills = data?.skills ?? [];
  const categories = data?.categories ?? [];
  const total = data?.total ?? 0;

  const handleInstall = async (skillId: string) => {
    setInstallingSkill(skillId);
    try {
      await apiPost('/api/admin/skills/install', { skillId });
      queryClient.invalidateQueries({ queryKey: ['skills-registry'] });
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    } catch (err) {
      console.error('Failed to install skill:', err);
    } finally {
      setInstallingSkill(null);
    }
  };

  const handleUninstall = async (skillId: string) => {
    setInstallingSkill(skillId);
    try {
      await apiDelete(`/api/admin/skills/install/${skillId}`);
      queryClient.invalidateQueries({ queryKey: ['skills-registry'] });
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    } catch (err) {
      console.error('Failed to uninstall skill:', err);
    } finally {
      setInstallingSkill(null);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Link href="/skills">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Skills
          </Button>
        </Link>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Skills Registry</h1>
          <p className="mt-2 text-gray-600">
            Browse and install skills from the community registry
          </p>
        </div>
      </div>

      {error && <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{error.message}</div>}

      {/* Search and Filters */}
      <Card className="mt-6">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <Input
                placeholder="Search skills..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            {/* Category Filter */}
            <div className="flex items-center gap-2 overflow-x-auto">
              <Button
                variant={selectedCategory === null ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedCategory(null)}
              >
                All
              </Button>
              {categories.map((category) => (
                <Button
                  key={category}
                  variant={selectedCategory === category ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedCategory(category)}
                  className="whitespace-nowrap"
                >
                  {category}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results Count */}
      <div className="mt-4 text-sm text-gray-500">
        {total} skill{total !== 1 ? 's' : ''} available
      </div>

      {/* Skills Grid */}
      {isLoading ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-6 bg-gray-200 rounded w-3/4 mb-2" />
                <div className="h-4 bg-gray-100 rounded w-full mb-4" />
                <div className="h-8 bg-gray-100 rounded w-1/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : skills.length === 0 ? (
        <Card className="mt-6">
          <CardContent className="p-8 text-center">
            <Puzzle className="h-12 w-12 mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500">No skills found matching your search.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => {
            const typeCfg = typeConfig[skill.type];
            const isInstalling = installingSkill === skill.id;

            return (
              <Card
                key={skill.id}
                className={clsx(
                  'transition-all hover:shadow-md',
                  skill.isInstalled && 'border-green-200 bg-green-50/30'
                )}
              >
                <CardContent className="p-5">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className={clsx('p-2 rounded-lg', typeCfg.bgColor, typeCfg.color)}>
                        {skill.emoji ? (
                          <span className="text-lg">{skill.emoji}</span>
                        ) : (
                          typeCfg.icon
                        )}
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900">{skill.displayName}</h3>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge className={clsx('text-xs', typeCfg.bgColor, typeCfg.color)}>
                            {typeCfg.label}
                          </Badge>
                          {skill.isOfficial && (
                            <Badge className="text-xs bg-yellow-100 text-yellow-700">
                              <Star className="h-3 w-3 mr-1" />
                              Official
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Description */}
                  <p className="text-sm text-gray-600 mb-3 line-clamp-2">{skill.description}</p>

                  {/* Tags */}
                  {skill.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {skill.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600"
                        >
                          {tag}
                        </span>
                      ))}
                      {skill.tags.length > 3 && (
                        <span className="text-xs text-gray-400">+{skill.tags.length - 3}</span>
                      )}
                    </div>
                  )}

                  {/* Stats */}
                  <div className="flex items-center gap-4 text-xs text-gray-500 mb-4">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {skill.installCount} installs
                    </span>
                    <span>v{skill.currentVersion}</span>
                    {skill.author && <span>by {skill.author}</span>}
                  </div>

                  {/* Action Button */}
                  {skill.isInstalled ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => handleUninstall(skill.id)}
                      disabled={isInstalling}
                    >
                      {isInstalling ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <CheckCircle className="h-4 w-4 mr-2" />
                      )}
                      {isInstalling ? 'Removing...' : 'Installed'}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => handleInstall(skill.id)}
                      disabled={isInstalling}
                    >
                      {isInstalling ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      {isInstalling ? 'Installing...' : 'Install'}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
