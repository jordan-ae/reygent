"use client";

import { useId, useState } from "react";

import { api, errorMessage } from "@/components/api-client";
import { useConsole } from "@/components/console-context";
import { TextField } from "@/components/fields";
import { Badge, EmptyState, ErrorCard, PageHead, RefreshButton, When } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { AnswersBody, StandingAnswer } from "@/core/web/types";

/** One remembered answer, with its edit form folded in. */
function AnswerRow({ answer, onChanged }: { answer: StandingAnswer; onChanged: () => void }) {
  const { toast } = useConsole();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(answer.answer);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const send = async (method: "PUT" | "DELETE", body: object, done: string) => {
    setSending(true);
    setProblem(null);
    try {
      await api<AnswersBody>(method, "/api/answers", body);
      toast(done);
      setEditing(false);
      onChanged();
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <article className="answer">
      <div className="answer-head">
        <span className="question">{answer.question}</span>
        {answer.source === "user" ? (
          <Badge tone="good">You</Badge>
        ) : (
          <Badge tone="accent">AI — verified against your data</Badge>
        )}
        <span className="sub">
          <When iso={answer.updatedAt} />
        </span>
        {editing ? null : (
          <>
            <button
              type="button"
              className="button small"
              aria-label={`Edit the answer to: ${answer.question}`}
              onClick={() => {
                setText(answer.answer);
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="button small danger"
              aria-label={`Delete the answer to: ${answer.question}`}
              disabled={sending}
              onClick={() => send("DELETE", { question: answer.question }, "Answer deleted.")}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {editing ? (
        <div className="field">
          <label htmlFor={inputId}>Your answer</label>
          {answer.options.length ? (
            // The form offered these choices; any other answer could not be given on it.
            <select id={inputId} value={text} onChange={(event) => setText(event.target.value)}>
              {answer.options.includes(text) ? null : <option value={text}>{text}</option>}
              {answer.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <textarea id={inputId} rows={3} value={text} onChange={(event) => setText(event.target.value)} />
          )}
          {answer.source === "ai" ? <p className="hint">Once you save it, this answer is yours: the AI will not change it.</p> : null}
          <div className="actions">
            <button
              type="button"
              className="button primary small"
              disabled={sending || !text.trim()}
              onClick={() => send("PUT", { question: answer.question, answer: text }, "Answer saved.")}
            >
              Save
            </button>
            <button type="button" className="button small" disabled={sending} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="given">{answer.answer}</p>
      )}
      {answer.options.length && !editing ? <p className="sub">Choices on the form: {answer.options.join(" / ")}</p> : null}
      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}
    </article>
  );
}

/** Teach Reygent an answer before any form asks for it. */
function AddAnswer({ onAdded }: { onAdded: () => void }) {
  const { toast } = useConsole();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Bumped after each save so the two fields start empty again.
  const [round, setRound] = useState(0);

  const add = async () => {
    setSending(true);
    setProblem(null);
    try {
      await api<AnswersBody>("PUT", "/api/answers", { question, answer });
      toast("Answer saved.");
      setQuestion("");
      setAnswer("");
      setRound((n) => n + 1);
      onAdded();
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="card">
      <h2>Add an answer</h2>
      <p className="lede">
        Write the question exactly as forms ask it. An answer only applies when the wording matches.
      </p>
      <div className="form-grid" key={round}>
        <TextField
          label="Question"
          wide
          placeholder="Will you now or in the future require visa sponsorship?"
          value={question}
          onChange={setQuestion}
        />
        <TextField label="Your answer" wide multiline rows={2} value={answer} onChange={setAnswer} />
      </div>
      <div className="actions">
        <button type="button" className="button primary" disabled={sending || !question.trim() || !answer.trim()} onClick={add}>
          Add answer
        </button>
      </div>
      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

export function AnswersView() {
  const { data, error, reload } = useApi<AnswersBody>("/api/answers");
  return (
    <>
      <PageHead
        title="Answers"
        subtitle="What Reygent says when a form asks a screening question. These are given every time that exact question is asked."
      >
        <RefreshButton onClick={reload} />
      </PageHead>
      {error ? (
        <ErrorCard message={error} onRetry={reload} />
      ) : data ? (
        <>
          <section className="card flush">
            <h2>Standing answers</h2>
            {data.answers.length ? (
              data.answers.map((answer) => (
                // Keyed by content too, so an edit made elsewhere never leaves a stale edit box open.
                <AnswerRow key={`${answer.question}\u0000${answer.updatedAt}`} answer={answer} onChanged={reload} />
              ))
            ) : (
              <EmptyState
                title="No answers yet"
                text="Answers appear here when you answer a held draft's question in Quarantine, when the AI answers a form question it could verify against your data, or when you add one below."
              />
            )}
          </section>
          <AddAnswer onAdded={reload} />
        </>
      ) : null}
    </>
  );
}
