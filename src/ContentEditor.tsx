import { useId, useState } from 'react';
import { z } from 'zod';
import type { Lesson, MemberCatalog } from '../shared/content-types';
import type { SessionInfo } from '../shared/contracts';
import type { LessonStep } from '../shared/lesson-flow';
import { lessonStepTitle } from '../shared/lesson-flow';
import { lessonSchema } from '../shared/content-schemas';
import { applyNuggetDraft, nuggetDraft } from '../shared/nugget-editor';
import { errorMessage, request } from './api';
import { LessonVisuals } from './LessonVisuals';

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return <div className="content-field"><label htmlFor={id}>{label}</label>
    <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} rows={value.length > 150 ? 5 : 2} required /></div>;
}

const formSchema = z.object({ content: z.record(z.string(), z.unknown()), visuals: z.array(z.unknown()) });
function formValue(value: string) {
  try { return formSchema.safeParse(JSON.parse(value)); }
  catch (failure) {
    if (!(failure instanceof SyntaxError)) throw failure;
    return { success: false as const };
  }
}

export function ContentEditor({ lesson, step, catalog, session, onSaved, onClose }: {
  lesson: Lesson; step?: LessonStep; catalog: MemberCatalog; session: SessionInfo;
  onSaved: (lesson: Lesson) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(step ? nuggetDraft(lesson, step) : lesson, null, 2));
  const [reason, setReason] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [preview, setPreview] = useState<Lesson | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fields = step ? formValue(draft) : null;
  function change(key: string, value: unknown) {
    if (!fields?.success) throw new Error('Correct the structured JSON before editing fields.');
    setDraft(JSON.stringify({ ...fields.data, content: { ...fields.data.content, [key]: value } }, null, 2));
    setPreview(null);
  }
  function parse(): Lesson {
    const value: unknown = JSON.parse(draft);
    return step ? applyNuggetDraft(lesson, step, value) : lessonSchema.parse(value);
  }
  return <section className="content-editor" aria-label="Training content editor">
    <h2>Edit {step ? lessonStepTitle(lesson, step) : lesson.shortTitle}</h2>
    <p>The same fields and renderer serve every topic. Edit the text below; use structured JSON for diagram nodes, relationships, or screenshots. Text is plain text, never HTML. Keep prose nuggets within 100 words and cite registered sources.</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      setBusy(true);
      setError('');
      void (async () => {
        try {
          const edited = parse();
          const saved = await request(`/management/content/${lesson.id}`, lessonSchema, {
            method: 'POST', csrfToken: session.csrfToken,
            body: { lesson: edited, expectedRevision: lesson.revision, reason, technicalReviewConfirmed: reviewed },
          });
          onSaved(saved);
          onClose();
        } catch (failure) { setError(errorMessage(failure)); }
        finally { setBusy(false); }
      })();
    }}>
      {fields?.success && <fieldset disabled={busy} className="nugget-fields"><legend>Nugget content</legend>
        {Object.entries(fields.data.content).map(([key, value]) => {
          const label = ({ gist: 'Summary text', objective: 'Learning objective', text: 'Teaching text', scenario: 'Scenario',
            prompt: 'Question or exercise prompt', expected: 'Exercise review', sourceId: 'Registered source ID',
            note: 'Example explanation', title: 'Title', code: 'Code example', language: 'Code language' } as Record<string, string>)[key] || key;
          if (key === 'id') return null;
          if (typeof value === 'string') return <TextField key={key} label={label} value={value} onChange={(text) => change(key, text)} />;
          if (key === 'correct' && typeof value === 'number') return <label key={key}>Correct option number (zero-based)
            <input type="number" min={0} max={9} step={1} value={value} onChange={(event) => change(key, event.target.valueAsNumber)} required /></label>;
          if (typeof value === 'boolean') return <label key={key}><input type="checkbox" checked={value} onChange={(event) => change(key, event.target.checked)} />{label}</label>;
          if (key !== 'choices') return null;
          const options = z.array(z.object({ text: z.string(), feedback: z.string() }).strict()).safeParse(value);
          return options.success ? <div key={key}>{options.data.map((option, index) => <fieldset key={index}>
            <legend>Option {index} {fields.data.content.correct === index ? '/ correct' : ''}</legend>
            <TextField label={`Option ${index} text`} value={option.text} onChange={(text) => change('choices', options.data.map((item, position) => position === index ? { ...item, text } : item))} />
            <TextField label={`Option ${index} review feedback`} value={option.feedback} onChange={(feedback) => change('choices', options.data.map((item, position) => position === index ? { ...item, feedback } : item))} />
          </fieldset>)}</div> : null;
        })}
      </fieldset>}
      {step && !fields?.success && <p className="notice">Correct the structured JSON before using the text fields.</p>}
      <details open={!step} className="advanced-content"><summary>Structured JSON and visuals</summary>
        <label htmlFor="content-json">Nugget JSON</label>
        <textarea id="content-json" className="content-json" rows={20} value={draft}
          onChange={(event) => { setDraft(event.target.value); setPreview(null); }} disabled={busy} required spellCheck={false} />
      </details>
      <label htmlFor="content-reason">Change reason</label>
      <input id="content-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} maxLength={500} required disabled={busy} />
      <label className="consent-label"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} disabled={busy} />
        <span>I reviewed the technical accuracy, primary sources, and removal of all personal/tenant data. Publishing creates a new lesson revision and requires new learning credit.</span></label>
      <div className="button-row">
        <button type="button" disabled={busy} onClick={() => {
          try { setPreview(parse()); setError(''); } catch (failure) { setPreview(null); setError(errorMessage(failure)); }
        }}>Validate and preview</button>
        <button type="submit" className="primary" disabled={busy || !reviewed}>{busy ? 'Publishing...' : 'Publish reviewed revision'}</button>
        <button type="button" onClick={onClose} disabled={busy}>Cancel editing</button>
      </div>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {preview && <div className="content-preview" aria-label="Content preview">
      <p role="status">Valid structured content. The published revision remains unchanged until you publish.</p>
      <pre>{JSON.stringify(step ? nuggetDraft(preview, step).content : { title: preview.title, gist: preview.gist }, null, 2)}</pre>
      <LessonVisuals visuals={(preview.visuals || []).filter((visual) => !step || visual.stepId === step.id)} catalog={catalog} />
    </div>}
  </section>;
}
