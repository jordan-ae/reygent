"use client";

import { useId, useState } from "react";

import {
  type AchievementDraft,
  achievementDraft,
  useBoot,
  useConsole,
} from "@/components/console-context";
import { CheckField, TagsField, TextField } from "@/components/fields";
import { POSITIONING_FALLBACK } from "@/components/labels";
import { Badge, EmptyState, PageHead, SetupNotices } from "@/components/ui";

interface Positioning {
  id: string;
  title: string;
}

function AchievementCard({
  achievement,
  positioning,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  achievement: AchievementDraft;
  positioning: Positioning[];
  open: boolean;
  onToggle: (open: boolean) => void;
  onChange: (next: AchievementDraft) => void;
  onRemove: () => void;
}) {
  const groupLabel = useId();
  const set = <K extends keyof AchievementDraft>(key: K, value: AchievementDraft[K]) =>
    onChange({ ...achievement, [key]: value });
  const togglePositioning = (id: string, supported: boolean) =>
    set("positioning", supported ? [...achievement.positioning, id] : achievement.positioning.filter((have) => have !== id));

  return (
    <details className="achievement" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary>
        <span className="headline">{achievement.headline || "Untitled achievement"}</span>
        <span>
          {achievement.verified ? (
            <Badge tone="good">Verified</Badge>
          ) : (
            <Badge tone="warning">Not verified — unusable</Badge>
          )}
        </span>
      </summary>
      <div className="body">
        <div className="form-grid">
          <TextField
            label="What you built or did"
            wide
            placeholder="Built a LangGraph agent runtime with checkpoint recovery"
            value={achievement.headline}
            onChange={(value) => set("headline", value)}
          />
          <TextField
            label="Measured result"
            wide
            placeholder="Cut workflow latency by 45%"
            hint="A CV bullet for this achievement may only use figures written here or in the context below. Write the exact numbers you can defend."
            value={achievement.impact_metric}
            onChange={(value) => set("impact_metric", value)}
          />
          <TagsField
            label="Technologies used"
            wide
            placeholder="e.g. Python, LangGraph"
            value={achievement.technologies}
            onChange={(value) => set("technologies", value)}
          />
          <TextField
            label="Where"
            placeholder="Employer or client, if you may name it"
            value={achievement.employer}
            onChange={(value) => set("employer", value)}
          />
          <TextField
            label="Evidence link"
            type="url"
            placeholder="https://github.com/…"
            value={achievement.evidence_url}
            onChange={(value) => set("evidence_url", value)}
          />
          <TextField
            label="Category"
            placeholder="e.g. ai_systems"
            value={achievement.category}
            onChange={(value) => set("category", value)}
          />
          <TextField
            label="Context"
            multiline
            wide
            value={achievement.context}
            onChange={(value) => set("context", value)}
          />
          <div className="field wide" role="group" aria-labelledby={groupLabel}>
            <span className="label" id={groupLabel}>
              Supports these positioning profiles
            </span>
            <div className="checks">
              {positioning.map((profile) => (
                <CheckField
                  key={profile.id}
                  label={profile.title}
                  checked={achievement.positioning.includes(profile.id)}
                  onChange={(supported) => togglePositioning(profile.id, supported)}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="foot">
          <CheckField
            label="I confirm every detail above is accurate. Reygent may state it to employers."
            checked={achievement.verified}
            onChange={(verified) => set("verified", verified)}
          />
          <button type="button" className="button small danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    </details>
  );
}

export function FactBankView() {
  const { boot, draft } = useBoot();
  const { editDraft, draftVersion } = useConsole();
  // While the config cannot be read there are no profiles from the server; the fixed four still apply.
  const positioning: Positioning[] = boot.positioning.length ? boot.positioning : POSITIONING_FALLBACK;
  const achievements = draft.fact_bank.achievements;
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  const setAchievements = (change: (list: AchievementDraft[]) => AchievementDraft[]) =>
    editDraft((current) => ({ ...current, fact_bank: { achievements: change(current.fact_bank.achievements) } }));
  const setOpen = (id: string, open: boolean) =>
    setOpenIds((current) => {
      if (current.has(id) === open) return current;
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const add = () => {
    const achievement = achievementDraft();
    setAchievements((list) => [...list, achievement]);
    setOpen(achievement.id, true);
  };

  return (
    <>
      <PageHead
        title="Fact bank"
        subtitle="Your verified achievements. Every figure, technology and employer Reygent writes must trace back to an entry here — anything else is rejected before it is sent."
      >
        <button type="button" className="button primary" onClick={add}>
          Add achievement
        </button>
      </PageHead>
      <SetupNotices errorOnly />
      <section className="card">
        <h2>Coverage</h2>
        <p className="lede">Each positioning profile needs at least one verified achievement behind it.</p>
        <div className="codes">
          {positioning.map((profile) => {
            const verified = achievements.filter((a) => a.verified && a.positioning.includes(profile.id)).length;
            return (
              <Badge key={profile.id} tone={verified ? "good" : "warning"}>
                {profile.title} · {verified} verified
              </Badge>
            );
          })}
        </div>
      </section>
      {/* Keyed by draft version so Discard or a save rebuilds every card from the saved config. */}
      <div key={draftVersion}>
        {achievements.length ? (
          achievements.map((achievement, index) => (
            <AchievementCard
              // Ids are meant to be unique, but a hand-edited file may repeat one; the position keeps keys distinct.
              key={`${achievement.id}:${achievements.slice(0, index).filter((a) => a.id === achievement.id).length}`}
              achievement={achievement}
              positioning={positioning}
              open={openIds.has(achievement.id)}
              onToggle={(open) => setOpen(achievement.id, open)}
              onChange={(next) => setAchievements((list) => list.map((item, at) => (at === index ? next : item)))}
              onRemove={() => setAchievements((list) => list.filter((_, at) => at !== index))}
            />
          ))
        ) : (
          <section className="card">
            <EmptyState
              title="No achievements yet"
              text="Add the work you want Reygent to draw on. Without at least one verified achievement, no CV bullet can be written."
            />
          </section>
        )}
      </div>
    </>
  );
}
