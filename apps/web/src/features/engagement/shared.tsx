'use client';

import { CircleAlert, Plug, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useChannels, useProviders } from '@/features/channels/hooks';
import { useApiErrorMessage } from '@/lib/api/errors';
import { eligibleChannels, needsReconnect } from './logic';

/** canais elegíveis + o escolhido (o primeiro por padrão) */
export function useEngagementChannel(kind: 'comments' | 'insights') {
  const channels = useChannels();
  const providers = useProviders();
  const list = eligibleChannels(channels.data, providers.data, kind);
  const [picked, setPicked] = useState<string | undefined>();
  const selected = list.find((c) => c.id === picked) ?? list[0];
  return {
    list,
    selected,
    select: setPicked,
    isPending: channels.isPending || providers.isPending,
    error: channels.error ?? providers.error,
    refetch: () => {
      void channels.refetch();
      void providers.refetch();
    },
  };
}

type ChannelOption = ReturnType<typeof useEngagementChannel>['list'][number];

export function ChannelSelect({
  channels,
  value,
  onChange,
}: {
  channels: ChannelOption[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const t = useTranslations('engagement');
  if (channels.length < 2) return null;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-64" aria-label={t('channelLabel')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {channels.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.username ? `@${c.username}` : (c.name ?? c.id)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** identidade da conta escolhida — a tela sempre diz de qual conta são os números */
export function ChannelIdentity({ channel }: { channel: ChannelOption }) {
  const label = channel.username ? `@${channel.username}` : (channel.name ?? '');
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar>
        {channel.avatarUrl ? <AvatarImage src={channel.avatarUrl} alt="" /> : null}
        <AvatarFallback>{label.replace('@', '').slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="truncate text-compact font-medium text-ink">{label}</span>
    </div>
  );
}

export function NoEligibleChannel() {
  const t = useTranslations('engagement');
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-surface-2 px-6 py-16 text-center">
      <Plug className="size-8 text-mist" aria-hidden />
      <p className="max-w-md text-compact leading-relaxed text-graphite">{t('noChannels')}</p>
      <Button asChild variant="outline" size="sm">
        <Link href="/conexoes">{t('goToConnections')}</Link>
      </Button>
    </div>
  );
}

/**
 * Erro de uma consulta: reconectar quando é token/permissão (tentar de novo não resolve), senão a
 * mensagem da API com "tentar de novo".
 */
export function EngagementError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useTranslations('engagement');
  const errorMessage = useApiErrorMessage();
  if (needsReconnect(error)) {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden />
        <AlertTitle>{t('reconnectTitle')}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {errorMessage(error)}
          <Button asChild variant="outline" size="sm">
            <Link href="/conexoes">{t('reconnect')}</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertDescription className="flex flex-wrap items-center gap-3">
        {errorMessage(error)}
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden />
          {t('retry')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
