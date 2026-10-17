import type { Question } from '../shared/content-types';

export function Quiz({ question, stage, number, total, selected, onSelect, busy }: {
  question: Question;
  stage: 'pre' | 'post';
  number: number;
  total: number;
  selected: number | null;
  onSelect: (answer: number) => void;
  busy: boolean;
}) {
  const prefix = stage === 'pre' ? 'diagnostic' : 'application';
  return <section className={`quiz quiz-${stage}`} aria-labelledby={`${prefix}-heading`}>
    <h2 id={`${prefix}-heading`} tabIndex={-1}>{stage === 'pre' ? 'Pre-topic question' : 'Application question'} {number} of {total}</h2>
    <p className="field-help">Choose an answer. Answers and explanations are shown at the end of the topic.</p>
    <fieldset className="question" disabled={busy}>
      <legend>{question.prompt}</legend>
      <p className="scenario">{question.scenario}</p>
      <div className="choices">{question.choices.map((option, choiceIndex) => <label key={choiceIndex} className={selected === choiceIndex ? 'chosen' : ''}>
        <input type="radio" name={`${prefix}-${question.id}`} checked={selected === choiceIndex} onChange={() => onSelect(choiceIndex)} />
        <span className="choice-letter">{String.fromCharCode(65 + choiceIndex)}.</span><span>{option.text}</span>
      </label>)}</div>
    </fieldset>
  </section>;
}
