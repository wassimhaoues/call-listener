import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUI } from "@/ui/UIContext.jsx";
import Button from "@/components/ui/Button.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import {
  buildEvidenceReferences,
  createPreparationBrief,
  extractCandidateFacts,
  extractJobRequirements,
  mergePreparationItems,
} from "@/services/preparation.js";

function Labeled({ id, label, children }) {
  return (
    <label htmlFor={id} className="block mb-3">
      <div className="text-sm font-medium mb-1">{label}</div>
      {React.cloneElement(children, {
        id,
        className: `input ${children.props.className || ""}`,
      })}
    </label>
  );
}

const emptyCandidate = { name: "", profile: "", skills: [], achievements: [] };
const emptyJobOffer = { title: "", company: "", description: "", requirements: [] };
const defaultSettings = { language: "fr", transcriptionLanguage: "fr", stage: "technical", answerLength: "standard" };

function modelLabel(model) {
  const name = model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
  if (model.availability === "unavailable") return `${name} — unavailable`;
  if (model.availability === "unknown") return `${name} — availability unknown`;
  return name;
}

function withoutEmptyModel(settings) {
  const { model, ...rest } = settings;
  return model ? { ...rest, model } : rest;
}

function listFromText(text) {
  return text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function ModelPicker({ catalog, failed, notice, value, onChange }) {
  const models = catalog?.models || [];
  const defaultModel = catalog?.defaultModel;
  return (
    <div className="mt-1">
      {models.length > 0 ? (
        <Labeled id="interviewModel" label="AI model">
          <select value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="">{defaultModel ? `Server default (${defaultModel})` : "Server default"}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id} disabled={model.availability === "unavailable"}>
                {modelLabel(model)}
              </option>
            ))}
          </select>
        </Labeled>
      ) : (
        <p className="text-sm text-[var(--text-2)]">
          {catalog || failed
            ? "Model selection is not available right now; the server default model will be used."
            : "Loading available models…"}
        </p>
      )}
      {notice && <p role="status" className="text-sm text-[var(--danger)]">{notice}</p>}
      <p className="text-xs text-[var(--text-2)]">Used for suggestions in this interview session.</p>
    </div>
  );
}

export default function Context() {
  const nav = useNavigate();
  const { setTitle } = useUI();
  const [candidate, setCandidate] = useState(emptyCandidate);
  const [jobOffer, setJobOffer] = useState(emptyJobOffer);
  const [settings, setSettings] = useState(defaultSettings);
  const [skillsText, setSkillsText] = useState("");
  const [achievementsText, setAchievementsText] = useState("");
  const [requirementsText, setRequirementsText] = useState("");
  const [cvText, setCvText] = useState("");
  const [evidence, setEvidence] = useState([]);
  const [brief, setBrief] = useState(null);
  const [legacyContext, setLegacyContext] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [modelNotice, setModelNotice] = useState("");

  useEffect(() => {
    const goIfOffline = () => {
      if (!navigator.onLine) nav("/autherror");
    };
    localStorage.setItem("lastPage", "/context");
    goIfOffline();
    window.addEventListener("offline", goIfOffline);
    return () => window.removeEventListener("offline", goIfOffline);
  }, [nav]);

  useEffect(() => setTitle("Candidate & Job Offer"), [setTitle]);

  useEffect(() => {
    try {
      const context = JSON.parse(localStorage.getItem("callContext") || "null");
      if (context?.version === 1) {
        setCandidate({ ...emptyCandidate, ...context.candidate });
        setJobOffer({ ...emptyJobOffer, ...context.jobOffer });
        setSettings({ ...defaultSettings, ...context.settings });
        setSkillsText((context.candidate?.skills || []).join(", "));
        setAchievementsText((context.candidate?.achievements || []).join("\n"));
        setRequirementsText((context.jobOffer?.requirements || []).join("\n"));
        setEvidence(context.evidence || []);
        setBrief(createPreparationBrief({
          candidate: { ...emptyCandidate, ...context.candidate },
          jobOffer: { ...emptyJobOffer, ...context.jobOffer },
        }));
      } else if (context?.caller || context?.me) {
        setLegacyContext(context);
      }
    } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.callApi?.getModels?.())
      .then((result) => {
        if (cancelled) return;
        if (result && Array.isArray(result.models)) setCatalog(result);
        else setCatalogFailed(true);
      })
      .catch(() => {
        if (!cancelled) setCatalogFailed(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!catalog || !settings.model) return;
    const saved = catalog.models.find((model) => model.id === settings.model);
    if (saved && saved.availability !== "unavailable") return;
    // Make a removed or unavailable choice visible instead of silently swapping models.
    setModelNotice(saved
      ? `Your previous model ${settings.model} is currently unavailable. Choose another model.`
      : `Your previous model ${settings.model} is no longer offered. Choose another model.`);
    setSettings(({ model: _removed, ...rest }) => rest);
  }, [catalog, settings.model]);

  function start() {
    if (!candidate.name.trim() || !jobOffer.title.trim()) {
      alert("Please provide your name and the job title.");
      return;
    }
    const preparedCandidate = {
      ...candidate,
      skills: listFromText(skillsText),
      achievements: listFromText(achievementsText),
    };
    const preparedJobOffer = {
      ...jobOffer,
      requirements: listFromText(requirementsText),
    };
    const context = {
      version: 1,
      candidate: preparedCandidate,
      jobOffer: preparedJobOffer,
      evidence: buildEvidenceReferences(preparedJobOffer.requirements, preparedCandidate),
      settings: withoutEmptyModel(settings),
    };
    localStorage.setItem("callContext", JSON.stringify(context));
    nav("/conversation");
  }

  function extractPreparationFacts() {
    const extractedCandidate = extractCandidateFacts(cvText);
    const extractedRequirements = extractJobRequirements(jobOffer.description);
    const nextSkills = mergePreparationItems(listFromText(skillsText), extractedCandidate.skills);
    const nextAchievements = mergePreparationItems(listFromText(achievementsText), extractedCandidate.achievements);
    const nextRequirements = mergePreparationItems(listFromText(requirementsText), extractedRequirements);
    setSkillsText(nextSkills.join(", "));
    setAchievementsText(nextAchievements.join("\n"));
    setRequirementsText(nextRequirements.join("\n"));
    setEvidence(buildEvidenceReferences(nextRequirements, {
      ...candidate,
      skills: nextSkills,
      achievements: nextAchievements,
    }));
    setBrief(createPreparationBrief({
      candidate: { ...candidate, skills: nextSkills, achievements: nextAchievements },
      jobOffer: { ...jobOffer, requirements: nextRequirements },
    }));
  }

  function importLegacyDraft() {
    if (!legacyContext) return;
    localStorage.setItem("callContextLegacyBackup", JSON.stringify(legacyContext));
    setCandidate({
      ...emptyCandidate,
      name: legacyContext.me?.name || "",
      profile: legacyContext.me?.description || "",
    });
    setJobOffer({
      ...emptyJobOffer,
      description: legacyContext.caller?.description || legacyContext.caller?.other || "",
    });
    setSkillsText("");
    setAchievementsText("");
    setRequirementsText("");
    setEvidence([]);
    setBrief(null);
    setLegacyContext(null);
  }

  return (
    <div className="h-full grid place-items-center">
      <Card className="w-full h-full flex flex-col overflow-y-auto">
        <CardHeader>Prepare Your Interview</CardHeader>
        <CardBody className="flex-1 flex flex-col overflow-y-auto">
          <p className="text-sm text-[var(--text-2)] mb-4">
            Add only facts you are comfortable using in an interview. The assistant
            uses this context to suggest answers; it should not invent experience.
          </p>
          {legacyContext && (
            <section className="panel p-4 mb-4">
              <h2 className="font-semibold">Legacy preparation data found</h2>
              <p className="text-sm text-[var(--text-2)] mt-1">Import it only if it is relevant. You will review it as a draft, and the original is backed up locally.</p>
              <Button className="mt-3" variant="secondary" onClick={importLegacyDraft}>Import legacy draft</Button>
            </section>
          )}
          <div className="flex-1 min-h-0">
            <div className="grid md:grid-cols-2 gap-4 h-full">
              <section className="panel p-4 overflow-auto no-scrollbar">
                <h2 className="font-semibold mb-3">Candidate Profile</h2>
                <Labeled id="candidateName" label="Your name">
                  <input value={candidate.name} onChange={(event) => setCandidate({ ...candidate, name: event.target.value })} />
                </Labeled>
                <Labeled id="candidateProfile" label="Relevant experience or profile">
                  <textarea className="textarea" rows={4} value={candidate.profile} onChange={(event) => setCandidate({ ...candidate, profile: event.target.value })} />
                </Labeled>
                <Labeled id="candidateCv" label="Paste CV text (kept in this screen only)">
                  <textarea className="textarea" rows={5} value={cvText} onChange={(event) => setCvText(event.target.value)} />
                </Labeled>
                <Labeled id="candidateSkills" label="Relevant skills (comma-separated)">
                  <textarea className="textarea" rows={3} value={skillsText} onChange={(event) => setSkillsText(event.target.value)} />
                </Labeled>
                <Labeled id="candidateAchievements" label="Achievements or examples (one per line)">
                  <textarea className="textarea" rows={4} value={achievementsText} onChange={(event) => setAchievementsText(event.target.value)} />
                </Labeled>
              </section>

              <section className="panel p-4 overflow-auto no-scrollbar">
                <h2 className="font-semibold mb-3">Job Offer</h2>
                <Labeled id="jobTitle" label="Job title">
                  <input value={jobOffer.title} onChange={(event) => setJobOffer({ ...jobOffer, title: event.target.value })} />
                </Labeled>
                <Labeled id="jobCompany" label="Company">
                  <input value={jobOffer.company} onChange={(event) => setJobOffer({ ...jobOffer, company: event.target.value })} />
                </Labeled>
                <Labeled id="jobDescription" label="Pasted job description or requirements">
                  <textarea className="textarea" rows={6} value={jobOffer.description} onChange={(event) => setJobOffer({ ...jobOffer, description: event.target.value })} />
                </Labeled>
                <Labeled id="jobRequirements" label="Job requirements (editable, one per line)">
                  <textarea className="textarea" rows={4} value={requirementsText} onChange={(event) => setRequirementsText(event.target.value)} />
                </Labeled>
                <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
                  <Labeled id="interviewLanguage" label="Answer language">
                    <select value={settings.language} onChange={(event) => setSettings({ ...settings, language: event.target.value })}>
                      <option value="fr">French</option><option value="en">English</option>
                    </select>
                  </Labeled>
                  <Labeled id="interviewStage" label="Interview stage">
                    <select value={settings.stage} onChange={(event) => setSettings({ ...settings, stage: event.target.value })}>
                      <option value="recruiter">Recruiter</option><option value="technical">Technical</option><option value="behavioral">Behavioral</option><option value="final">Final</option><option value="other">Other</option>
                    </select>
                  </Labeled>
                  <Labeled id="transcriptionLanguage" label="Transcription language">
                    <select value={settings.transcriptionLanguage} onChange={(event) => setSettings({ ...settings, transcriptionLanguage: event.target.value })}>
                      <option value="fr">French</option><option value="en">English</option>
                    </select>
                  </Labeled>
                  <Labeled id="answerLength" label="Answer length">
                    <select value={settings.answerLength} onChange={(event) => setSettings({ ...settings, answerLength: event.target.value })}>
                      <option value="short">Short</option><option value="standard">Standard</option><option value="detailed">Detailed</option>
                    </select>
                  </Labeled>
                </div>
                <ModelPicker
                  catalog={catalog}
                  failed={catalogFailed}
                  notice={modelNotice}
                  value={settings.model || ""}
                  onChange={(model) => {
                    setModelNotice("");
                    setSettings(withoutEmptyModel({ ...settings, model }));
                  }}
                />
              </section>
            </div>
          </div>
          <section className="panel p-4 mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">Preparation references</h2>
                <p className="text-sm text-[var(--text-2)]">Extract facts locally, then review the editable fields before starting.</p>
              </div>
              <Button variant="secondary" onClick={extractPreparationFacts}>Extract facts locally</Button>
            </div>
            {evidence.length > 0 && (
              <ul className="text-sm mt-3 space-y-1">
                {evidence.map((item) => <li key={`${item.requirement}-${item.evidence}`}>{item.requirement} → {item.evidence}</li>)}
              </ul>
            )}
            {brief && (
              <div className="grid md:grid-cols-2 gap-4 text-sm mt-4">
                <div><h3 className="font-medium">Introduction outline</h3><ul>{brief.introduction.map((item) => <li key={item}>{item}</li>)}</ul></div>
                <div><h3 className="font-medium">Questions to ask</h3><ul>{brief.questions.map((item) => <li key={item}>{item}</li>)}</ul></div>
                <div><h3 className="font-medium">STAR examples to prepare</h3><ul>{brief.starExamples.map((item) => <li key={item}>{item}</li>)}</ul></div>
                <div><h3 className="font-medium">Practice topics</h3><ul>{brief.practiceTopics.map((item) => <li key={item}>{item}</li>)}</ul></div>
              </div>
            )}
          </section>
          <div className="mt-4 flex justify-between">
            <Button variant="ghost" onClick={() => nav("/")}>Back</Button>
            <Button onClick={start}>Start Interview</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
