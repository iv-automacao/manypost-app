import { describe, expect, it } from 'bun:test';
import { CommentAutomationConfigSchema } from './automation';

const base = {
  trigger: { keywords: ['cotação'] },
  opening: { text: 'Oi! Toque abaixo que eu te mando os detalhes.' },
  finish: { text: 'Pronto! Fale com a gente no WhatsApp.' },
};

describe('CommentAutomationConfigSchema', () => {
  it('preenche os padrões: qualquer post, abertura com botão, aviso de automação', () => {
    const cfg = CommentAutomationConfigSchema.parse(base);
    expect(cfg.version).toBe(1);
    expect(cfg.trigger.mediaIds).toEqual([]);
    expect(cfg.opening).toMatchObject({ mode: 'button', buttonTitle: 'Quero!' });
    expect(cfg.disclosure).toBe(true);
    expect(cfg.questions).toEqual([]);
  });

  it('título de botão acima de 20 caracteres é recusado', () => {
    const r = CommentAutomationConfigSchema.safeParse({
      ...base,
      opening: { ...base.opening, buttonTitle: 'Quero receber agora mesmo' },
    });
    expect(r.success).toBe(false);
  });

  it('pergunta de escolha aceita até 13 opções', () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Opção ${i + 1}` }));
    const ok = { ...base, questions: [{ kind: 'choice', field: 'plano', prompt: 'Qual?', options: opts(13) }] };
    expect(CommentAutomationConfigSchema.safeParse(ok).success).toBe(true);
    const bad = { ...base, questions: [{ kind: 'choice', field: 'plano', prompt: 'Qual?', options: opts(14) }] };
    expect(CommentAutomationConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('campo repetido entre perguntas é recusado', () => {
    const r = CommentAutomationConfigSchema.safeParse({
      ...base,
      questions: [
        { kind: 'text', field: 'nome', prompt: 'Seu nome?', validate: 'name' },
        { kind: 'text', field: 'nome', prompt: 'De novo?', validate: 'free' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('WhatsApp exige só dígitos com DDI', () => {
    const wa = (phone: string) => ({ ...base, finish: { ...base.finish, whatsapp: { phone } } });
    expect(CommentAutomationConfigSchema.safeParse(wa('5592999990000')).success).toBe(true);
    expect(CommentAutomationConfigSchema.safeParse(wa('+55 92 99999-0000')).success).toBe(false);
  });

  it('id de post não numérico é recusado', () => {
    const r = CommentAutomationConfigSchema.safeParse({ ...base, trigger: { mediaIds: ['../me'] } });
    expect(r.success).toBe(false);
  });
});
