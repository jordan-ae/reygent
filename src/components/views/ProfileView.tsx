"use client";

import { Fragment, type ReactNode, useState } from "react";

import { type ConfigDraft, useBoot, useConsole, useDraftSection } from "@/components/console-context";
import { CheckField, NumberField, TagsField, TextField } from "@/components/fields";
import { PageHead, SetupNotices } from "@/components/ui";

type Role = ConfigDraft["candidate"]["experience"][number];
type Project = ConfigDraft["candidate"]["projects"][number];

/** A text box of one entry per line, as the list it stands for. */
const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** One entry of a list on the CV, folded away under its name until opened. */
function Entry({
  name,
  note,
  startOpen,
  onRemove,
  children,
}: {
  name: string;
  note?: string;
  startOpen: boolean;
  onRemove: () => void;
  children: ReactNode;
}) {
  // Held here, not derived from the fields: an entry must not fold shut while its name is being typed.
  const [open, setOpen] = useState(startOpen);
  return (
    <details className="achievement" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="headline">{name}</span>
        {note ? <span className="sub">{note}</span> : null}
      </summary>
      <div className="body">
        <div className="form-grid">{children}</div>
        <div className="foot">
          <span />
          <button type="button" className="button small danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    </details>
  );
}

function RoleEntry({ role, onChange, onRemove }: { role: Role; onChange: (next: Role) => void; onRemove: () => void }) {
  const set = <K extends keyof Role>(key: K, value: Role[K]) => onChange({ ...role, [key]: value });
  return (
    <Entry
      name={[role.title, role.employer].filter(Boolean).join(" · ") || "New role"}
      note={[role.start, role.end].filter(Boolean).join(" - ")}
      startOpen={!role.employer}
      onRemove={onRemove}
    >
      <TextField label="Job title" placeholder="Senior Full-Stack Engineer" value={role.title} onChange={(value) => set("title", value)} />
      <TextField
        label="Employer"
        hint="Spelled as in your fact bank: verified achievements that name this employer are printed under this role."
        value={role.employer}
        onChange={(value) => set("employer", value)}
      />
      <TextField label="Location" placeholder="City, Country" value={role.location} onChange={(value) => set("location", value)} />
      <TextField label="From" placeholder="Jan 2025" value={role.start} onChange={(value) => set("start", value)} />
      <TextField label="To" placeholder="Present" value={role.end} onChange={(value) => set("end", value)} />
      <TextField
        label="More lines for this role"
        multiline
        rows={3}
        wide
        hint="One per line, in your own words: lines of your CV that the fact bank does not hold. Printed as written, never reworded."
        value={role.highlights.join("\n")}
        onChange={(value) => set("highlights", lines(value))}
      />
    </Entry>
  );
}

function ProjectEntry({
  project,
  onChange,
  onRemove,
}: {
  project: Project;
  onChange: (next: Project) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof Project>(key: K, value: Project[K]) => onChange({ ...project, [key]: value });
  return (
    <Entry name={project.name || "New project"} startOpen={!project.name} onRemove={onRemove}>
      <TextField label="Project name" value={project.name} onChange={(value) => set("name", value)} />
      <TagsField
        label="Verified achievements"
        hint="The ids of fact-bank entries that belong to this project, e.g. ach_my_project."
        value={project.achievements}
        onChange={(value) => set("achievements", value)}
      />
      <TextField
        label="More lines for this project"
        multiline
        rows={3}
        wide
        hint="One per line, in your own words. Printed as written."
        value={project.highlights.join("\n")}
        onChange={(value) => set("highlights", lines(value))}
      />
    </Entry>
  );
}

export function ProfileView() {
  const { draft } = useBoot();
  const { draftVersion } = useConsole();
  const set = useDraftSection("candidate");
  const setPipeline = useDraftSection("pipeline");
  const candidate = draft.candidate;
  // Fields hold their own text, so adding or removing an entry rebuilds the list rather than shifting text between cards.
  const [listVersion, setListVersion] = useState(0);
  const setRoles = (roles: Role[], rebuilt = false) => {
    set("experience", roles);
    if (rebuilt) setListVersion((version) => version + 1);
  };
  const setProjects = (projects: Project[], rebuilt = false) => {
    set("projects", projects);
    if (rebuilt) setListVersion((version) => version + 1);
  };
  const tuned = draft.pipeline.tune_cv && candidate.experience.some((role) => role.employer.trim() && role.title.trim());
  return (
    <>
      <PageHead
        title="Profile"
        subtitle="Who you are and how you work. These are the only identity facts Reygent may state or type into a form."
      />
      <SetupNotices errorOnly />
      {/* Fields hold their own text while typing; a new key rebuilds them after Discard or a save. */}
      <Fragment key={draftVersion}>
        <section className="card">
          <h2>Screening notes</h2>
          <p className="lede">
            Facts the AI may use to answer screening questions. Spell out the legal ones — your citizenship, whether
            you need sponsorship, where you are authorized to work — so it reads them rather than inferring them.
          </p>
          <p className="lede">
            The more of these you state, the more forms go through without stopping. Real forms most often ask: the
            city and country you live in and your passport country; whether you are over 18; where you are and are not
            authorized to work, and whether you need sponsorship; how you heard about the role; how long you have
            worked remotely and in startups; your English level; and whether you can travel to meet a team a few times
            a year. Say nothing here about what you earn now — Reygent never answers that.
          </p>
          <div className="form-grid">
            <TextField
              label="Notes"
              multiline
              rows={6}
              wide
              placeholder="e.g. Cameroonian citizen, resident in Cameroon. I do not need visa sponsorship: I work as an independent contractor and invoice the client. I am not authorized to work as an employee in the US, UK or EU."
              hint="A question these notes and your profile cannot answer is never guessed: the draft is held and you are asked once."
              value={candidate.screening_notes}
              onChange={(value) => set("screening_notes", value)}
            />
          </div>
        </section>
        <section className="card">
          <h2>You</h2>
          <div className="form-grid">
            <TextField label="Full name" required value={candidate.name} onChange={(value) => set("name", value)} />
            <TextField
              label="Email"
              type="email"
              required
              value={candidate.email}
              onChange={(value) => set("email", value)}
            />
            <TextField
              label="Phone"
              required
              placeholder="+237 …"
              value={candidate.phone}
              onChange={(value) => set("phone", value)}
            />
            <NumberField
              label="Years of experience"
              nullable
              min={0}
              max={60}
              value={candidate.years_experience}
              onChange={(value) => set("years_experience", value)}
            />
          </div>
        </section>
        <section className="card">
          <h2>Your CV</h2>
          <p className="lede">
            {tuned
              ? "Each application attaches your CV rebuilt around its listing: a summary that opens with what the listing is hiring for, the listing's own words for the skills you have and the work you describe, and your most relevant work first, in a layout that applicant tracking systems read cleanly."
              : "Applications attach your CV file exactly as it is; without one, a one-page resume is generated from your verified achievements. List your work history below and each application gets your whole CV rebuilt around its listing instead."}
          </p>
          <p className="lede">
            Tuning changes wording, never substance: a reworded line or summary is printed only when a second check
            finds it says nothing your verified facts do not. A skill a listing asks for that you do not list is left
            off the page and shown to you on the application, so you can add it here if it is true.
          </p>
          <CheckField
            label="Tune my CV to each listing"
            hint="On: the tuned CV is what goes out, and the file below is not used. A tuned CV that cannot be read back cleanly is repaired and printed again; if that fails the application is held for you, never sent with another CV. Off: every application attaches the file below, exactly as it is."
            checked={draft.pipeline.tune_cv}
            onChange={(value) => setPipeline("tune_cv", value)}
          />
          <div className="form-grid">
            <TextField
              label="CV file (PDF)"
              wide
              placeholder="~/Documents/my-cv.pdf"
              hint="The path to the PDF on this Mac. Attached as it is only when tuning is off or you have listed no work history."
              value={candidate.resume_path}
              onChange={(value) => set("resume_path", value)}
            />
            <TextField
              label="Summary"
              multiline
              rows={3}
              wide
              hint="Your own summary. On a tuned CV it is rewritten for each listing from this and your verified work; when a rewrite cannot be verified, this is printed as written."
              value={candidate.summary}
              onChange={(value) => set("summary", value)}
            />
          </div>
        </section>
        <section className="card">
          <h2>Work history</h2>
          <p className="lede">
            Your roles as your CV has them, most recent first. Each is printed with the verified achievements that
            name its employer.
          </p>
          <div key={`roles-${listVersion}`}>
            {candidate.experience.map((role, index) => (
              <RoleEntry
                key={index}
                role={role}
                onChange={(next) => setRoles(candidate.experience.map((item, at) => (at === index ? next : item)))}
                onRemove={() => setRoles(candidate.experience.filter((_, at) => at !== index), true)}
              />
            ))}
          </div>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() =>
                setRoles([...candidate.experience, { employer: "", title: "", location: "", start: "", end: "", highlights: [] }], true)
              }
            >
              Add a role
            </button>
          </div>
        </section>
        <section className="card">
          <h2>Projects</h2>
          <p className="lede">Work of your own, outside a job. Each is printed with the verified achievements you list for it.</p>
          <div key={`projects-${listVersion}`}>
            {candidate.projects.map((project, index) => (
              <ProjectEntry
                key={index}
                project={project}
                onChange={(next) => setProjects(candidate.projects.map((item, at) => (at === index ? next : item)))}
                onRemove={() => setProjects(candidate.projects.filter((_, at) => at !== index), true)}
              />
            ))}
          </div>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => setProjects([...candidate.projects, { name: "", achievements: [], highlights: [] }], true)}
            >
              Add a project
            </button>
          </div>
        </section>
        <section className="card">
          <h2>Education</h2>
          <div className="form-grid">
            <TextField
              label="Education"
              multiline
              rows={2}
              wide
              placeholder="BSc Computer Science, University of Somewhere, 2021"
              hint="One qualification per line, as your CV has it. Left empty, the CV prints no Education section: Reygent never fills one in."
              value={candidate.education.join("\n")}
              onChange={(value) => set("education", lines(value))}
            />
          </div>
        </section>
        <section className="card">
          <h2>Where and how you work</h2>
          <div className="form-grid">
            <TextField label="Location" value={candidate.location} onChange={(value) => set("location", value)} />
            <TextField label="Time zone" value={candidate.timezone} onChange={(value) => set("timezone", value)} />
            <TextField
              label="Work status"
              multiline
              wide
              hint="Used verbatim when a form asks for your work authorization in free text. Multiple-choice work-status questions are always held for you."
              value={candidate.work_authorization}
              onChange={(value) => set("work_authorization", value)}
            />
            <TextField
              label="Notice period"
              required
              placeholder="e.g. 2 weeks"
              hint="The only availability Reygent may ever state. Any other start date in a draft is rejected."
              value={candidate.notice_period}
              onChange={(value) => set("notice_period", value)}
            />
          </div>
        </section>
        <section className="card">
          <h2>Links</h2>
          <p className="lede">
            Reygent only ever sends links listed here or attached to a verified achievement, and checks that each one
            is live first.
          </p>
          <div className="form-grid">
            <TextField
              label="GitHub"
              type="url"
              required
              placeholder="https://github.com/your-handle"
              value={candidate.github_url}
              onChange={(value) => set("github_url", value)}
            />
            <TextField
              label="LinkedIn"
              type="url"
              required
              placeholder="https://www.linkedin.com/in/your-handle"
              value={candidate.linkedin_url}
              onChange={(value) => set("linkedin_url", value)}
            />
            <TextField
              label="Portfolio"
              type="url"
              required
              placeholder="https://"
              value={candidate.portfolio_url}
              onChange={(value) => set("portfolio_url", value)}
            />
          </div>
        </section>
        <section className="card">
          <h2>Employers and skills</h2>
          <div className="form-grid">
            <TagsField
              label="Employers and clients you may name"
              wide
              hint="A pitch that names any other organisation as your employer or client is rejected."
              value={candidate.employers}
              onChange={(value) => set("employers", value)}
            />
            <TagsField
              label="Additional skills"
              wide
              hint="Skills you can truthfully claim beyond the technologies of your verified achievements. Only these and those are ever named as yours."
              value={candidate.skills}
              onChange={(value) => set("skills", value)}
            />
          </div>
        </section>
      </Fragment>
    </>
  );
}
