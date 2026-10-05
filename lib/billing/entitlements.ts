import {
  ANTHROPIC_MAX_TOKENS,
  MAX_AGENT_TURNS,
  getAnthropicModel,
} from '@/lib/agent/constants';

import { PublishVisibility } from '../publish/visibility';

export type AppTier = 'guest' | 'free' | 'pro';

export type UserBillingFields = {
  subscriptionPlan: string;
  subscriptionStatus: string | null;
};

export type AgentLimits = {
  maxTurns: number;
  maxTokens: number;
  model: string;
};

export const FREE_PROJECT_LIMIT = 3;
export const FREE_PRIVATE_DEPLOYMENT_LIMIT = 1;

const FREE_AGENT_LIMITS: AgentLimits = {
  maxTurns: 12,
  maxTokens: 8_192,
  model: getAnthropicModel(),
};

const PRO_AGENT_LIMITS: AgentLimits = {
  maxTurns: MAX_AGENT_TURNS,
  maxTokens: ANTHROPIC_MAX_TOKENS,
  model: getAnthropicModel(),
};

export function isProUser(user: UserBillingFields): boolean {
  return (
    user.subscriptionPlan === 'pro' &&
    (user.subscriptionStatus === 'active' ||
      user.subscriptionStatus === 'trialing')
  );
}

export function getAppTier(
  user: UserBillingFields | null | undefined,
): AppTier {
  if (!user) {
    return 'guest';
  }

  return isProUser(user) ? 'pro' : 'free';
}

export function getAgentLimits(tier: AppTier): AgentLimits {
  if (tier === 'pro') {
    return PRO_AGENT_LIMITS;
  }

  return FREE_AGENT_LIMITS;
}

export function canPublishVisibility(
  tier: AppTier,
  visibility: PublishVisibility,
): boolean {
  if (tier === 'pro') {
    return true;
  }

  return visibility === 'private';
}

export function getProjectLimit(tier: AppTier): number | null {
  if (tier === 'free') {
    return FREE_PROJECT_LIMIT;
  }

  return null;
}

export function publishUpgradeMessage(visibility: PublishVisibility): string {
  if (visibility === 'public') {
    return 'Public publishing is a Pro feature. Upgrade to Pro to share your project with anyone.';
  }

  if (visibility === 'workspace') {
    return 'Workspace publishing is a Pro feature. Upgrade to Pro to publish to your workspace.';
  }

  return 'Upgrade to Pro for more publishing options.';
}

export function projectLimitMessage(limit: number): string {
  return `Free plan is limited to ${limit} active projects. Upgrade to Pro for unlimited projects.`;
}

export const FREE_PLAN_FEATURES = [
  'Up to 3 active projects',
  'Agent with Economy limits',
  'Plan mode and prompt attachments',
  'Private publish (1 project)',
] as const;

export const PRO_PLAN_FEATURES = [
  'Unlimited projects',
  'Full agent limits and premium models',
  'Public and workspace publishing',
  'Commercial use',
] as const;
