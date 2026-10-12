'use client';

import { Eye, EyeOff, ExternalLink, MessageSquare, RefreshCw, Reply } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useApiErrorMessage } from '@/lib/api/errors';
import type { components } from '@/lib/api/schema';
import { relativeTime } from '@/lib/datetime';
import { cn } from '@/lib/utils';
import { useComments, useRecentMedia, useReplyToComment, useSetCommentHidden } from './hooks';
import { REPLY_MAX, captionPreview, replyState } from './logic';
import {
  ChannelIdentity,
  ChannelSelect,
  EngagementError,
  NoEligibleChannel,
  useEngagementChannel,
} from './shared';

type Media = components['schemas']['EngagementMedia'];
type Comment = components['schemas']['EngagementComment'];
type ReplyItem = components['schemas']['EngagementReply'];

function MediaThumb({ media }: { media: Media }) {
  return media.previewUrl ? (
    // URL temporária do CDN da rede: só exibida, nunca guardada
    <img src={media.previewUrl} alt="" className="size-12 shrink-0 rounded-compact bg-surface-2 object-cover" />
  ) : (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-compact bg-surface-2">
      <MessageSquare className="size-4 text-mist" aria-hidden />
    </span>
  );
}

function PostList({
  channelId,
  selected,
  onSelect,
}: {
  channelId: string;
  selected: string | undefined;
  onSelect: (media: Media) => void;
}) {
  const t = useTranslations('comments');
  const te = useTranslations('engagement');
  const locale = useLocale();
  const media = useRecentMedia(channelId);

  if (media.isPending) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }
  if (media.isError) return <EngagementError error={media.error} onRetry={() => void media.refetch()} />;

  const items = media.data.pages.flatMap((p) => p.items);
  if (items.length === 0) {
    return <p className="rounded-card bg-surface-2 px-4 py-6 text-compact text-graphite">{t('noPosts')}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {items.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onSelect(m)}
              aria-current={selected === m.id ? 'true' : undefined}
              className={cn(
                'flex w-full cursor-pointer items-center gap-3 rounded-lg border p-3 text-left outline-none transition-colors duration-200',
                'hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                selected === m.id ? 'border-accent bg-accent-tint' : 'border-line bg-surface',
              )}
            >
              <MediaThumb media={m} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-compact text-ink">
                  {captionPreview(m.caption, 70) || te('noCaption')}
                </span>
                <span className="text-meta text-graphite">
                  {te.has(`mediaType.${m.productType ?? m.mediaType}`)
                    ? te(`mediaType.${m.productType ?? m.mediaType}`)
                    : m.mediaType}
                  {m.timestamp ? ` · ${relativeTime(m.timestamp, locale)}` : ''}
                  {typeof m.commentsCount === 'number' ? ` · ${t('commentsCount', { count: m.commentsCount })}` : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {media.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void media.fetchNextPage()}
          isLoading={media.isFetchingNextPage}
        >
          {te('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function ReplyComposer({
  channelId,
  mediaId,
  commentId,
  onDone,
}: {
  channelId: string;
  mediaId: string;
  commentId: string;
  onDone: () => void;
}) {
  const t = useTranslations('comments');
  const errorMessage = useApiErrorMessage();
  const reply = useReplyToComment(channelId, mediaId);
  const [draft, setDraft] = useState('');
  // a chave só muda depois de um sucesso: clique duplo/reenvio reaproveita e a API não responde duas vezes
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const state = replyState(draft);

  const send = () => {
    if (!state.canSend || reply.isPending) return;
    reply.mutate(
      { commentId, message: draft.trim(), idempotencyKey },
      {
        onSuccess: () => {
          toast.success(t('replySent'));
          setDraft('');
          setIdempotencyKey(crypto.randomUUID());
          onDone();
        },
        onError: (err) => {
          const uncertain = (err as { extra?: { uncertain?: boolean } }).extra?.uncertain === true;
          toast.error(uncertain ? t('replyUncertain') : errorMessage(err));
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line-strong bg-surface p-3">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('replyPlaceholder')}
        aria-label={t('replyPlaceholder')}
        rows={3}
        maxLength={REPLY_MAX + 200}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cn('text-meta tabular-nums', state.over ? 'text-state-failed' : 'text-graphite')}>
          {t('replyCounter', { length: state.length, max: REPLY_MAX })} · {t('publicNote')}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDone} disabled={reply.isPending}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={send} disabled={!state.canSend} isLoading={reply.isPending}>
            {t('send')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function HideToggle({
  channelId,
  mediaId,
  item,
}: {
  channelId: string;
  mediaId: string;
  item: Pick<Comment, 'id' | 'hidden'>;
}) {
  const t = useTranslations('comments');
  const errorMessage = useApiErrorMessage();
  const setHidden = useSetCommentHidden(channelId, mediaId);
  const next = !item.hidden;
  return (
    <Button
      variant="ghost"
      size="sm"
      isLoading={setHidden.isPending}
      onClick={() =>
        setHidden.mutate(
          { commentId: item.id, hidden: next },
          {
            onSuccess: () => toast.success(next ? t('hidden') : t('unhidden')),
            onError: (err) => toast.error(errorMessage(err)),
          },
        )
      }
    >
      {item.hidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
      {item.hidden ? t('unhide') : t('hide')}
    </Button>
  );
}

function CommentLine({ item }: { item: Comment | ReplyItem }) {
  const t = useTranslations('comments');
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-compact font-medium text-ink">
          {item.username ? `@${item.username}` : t('anonymous')}
        </span>
        {item.fromOwner ? <Badge variant="accent">{t('ownerBadge')}</Badge> : null}
        {item.hidden ? <Badge variant="neutral">{t('hiddenBadge')}</Badge> : null}
        {item.timestamp ? (
          <span className="text-meta text-graphite">{relativeTime(item.timestamp, locale)}</span>
        ) : null}
      </div>
      <p className={cn('whitespace-pre-wrap text-compact leading-relaxed', item.hidden ? 'text-graphite' : 'text-ink')}>
        {item.text}
      </p>
    </div>
  );
}

function CommentItem({ channelId, mediaId, comment }: { channelId: string; mediaId: string; comment: Comment }) {
  const t = useTranslations('comments');
  const [replying, setReplying] = useState(false);
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <CommentLine item={comment} />
      {!comment.fromOwner ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setReplying((v) => !v)} aria-expanded={replying}>
            <Reply aria-hidden />
            {t('reply')}
          </Button>
          <HideToggle channelId={channelId} mediaId={mediaId} item={comment} />
        </div>
      ) : null}
      {replying ? (
        <ReplyComposer
          channelId={channelId}
          mediaId={mediaId}
          commentId={comment.id}
          onDone={() => setReplying(false)}
        />
      ) : null}
      {comment.replies.length > 0 ? (
        <ul className="flex flex-col gap-3 border-l border-line pl-4">
          {comment.replies.map((r) => (
            <li key={r.id} className="flex flex-col gap-1">
              <CommentLine item={r} />
              {!r.fromOwner ? (
                <div>
                  <HideToggle channelId={channelId} mediaId={mediaId} item={r} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CommentsPanel({ channelId, media }: { channelId: string; media: Media | undefined }) {
  const t = useTranslations('comments');
  const te = useTranslations('engagement');
  const comments = useComments(channelId, media?.id);

  if (!media) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg bg-surface-2 px-6 py-16 text-center">
        <MessageSquare className="size-8 text-mist" aria-hidden />
        <p className="text-compact text-graphite">{t('pickPost')}</p>
      </div>
    );
  }

  const items = comments.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card className="flex min-w-0 flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <MediaThumb media={media} />
          <p className="min-w-0 text-compact text-ink">{captionPreview(media.caption, 140) || te('noCaption')}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void comments.refetch()}
            isLoading={comments.isRefetching}
          >
            <RefreshCw aria-hidden />
            {t('refresh')}
          </Button>
          {media.permalink ? (
            <Button asChild variant="ghost" size="sm">
              <a href={media.permalink} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
                {te('openOnNetwork')}
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      {comments.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
        </div>
      ) : comments.isError ? (
        <EngagementError error={comments.error} onRetry={() => void comments.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-compact text-graphite">{t('noComments')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((c) => (
            <CommentItem key={c.id} channelId={channelId} mediaId={media.id} comment={c} />
          ))}
        </ul>
      )}

      {comments.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void comments.fetchNextPage()}
          isLoading={comments.isFetchingNextPage}
        >
          {te('loadMore')}
        </Button>
      ) : null}
    </Card>
  );
}

function CommentsBoard({ channelId }: { channelId: string }) {
  const t = useTranslations('comments');
  const [media, setMedia] = useState<Media | undefined>();
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <section className="flex min-w-0 flex-col gap-3" aria-label={t('posts')}>
        <h2 className="text-panel font-medium text-ink">{t('posts')}</h2>
        <PostList channelId={channelId} selected={media?.id} onSelect={setMedia} />
      </section>
      <section className="min-w-0">
        <CommentsPanel channelId={channelId} media={media} />
      </section>
    </div>
  );
}

export function CommentsView() {
  const t = useTranslations('comments');
  const ch = useEngagementChannel('comments');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={<ChannelSelect channels={ch.list} value={ch.selected?.id} onChange={ch.select} />}
      />
      {ch.isPending ? (
        <Skeleton className="h-96 rounded-lg" />
      ) : ch.error ? (
        <EngagementError error={ch.error} onRetry={ch.refetch} />
      ) : !ch.selected ? (
        <NoEligibleChannel />
      ) : (
        <>
          <ChannelIdentity channel={ch.selected} />
          {/* key: trocar de conta zera o post escolhido */}
          <CommentsBoard key={ch.selected.id} channelId={ch.selected.id} />
        </>
      )}
    </div>
  );
}
