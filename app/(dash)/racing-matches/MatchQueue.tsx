"use client";

import { useState } from "react";
import {
  ageFromFoalingYear,
  valuesAgree,
  type MatchProposal,
} from "./data";

// The interactive half of the match queue. The server component hands it the
// pending proposals; confirming or rejecting PATCHes the BFF and drops the
// card from the list (the proposal is no longer pending, so a refresh would
// drop it anyway).
//
// Guardrail: only the seven allowlisted evidence fields are rendered — the
// feed's owner field is never stored (RF1) and there is no owner UI anywhere
// in admin (guardrail 4). No odds/bookmaker fields either.

type Row = {
  field: string;
  platform: string | number | null;
  feed: string | number | null;
};

function buildRows(p: MatchProposal): Row[] {
  const h = p.horse;
  const e = p.evidence;
  return [
    { field: "Name", platform: h.racingName ?? h.displayName, feed: e.name ?? null },
    { field: "Sire", platform: h.sire, feed: e.sire ?? null },
    { field: "Dam", platform: h.dam, feed: e.dam ?? null },
    { field: "Age", platform: ageFromFoalingYear(h.foalingYear), feed: e.age ?? null },
    { field: "Sex", platform: h.sex, feed: e.sex ?? null },
    { field: "Colour", platform: h.colour, feed: e.colour ?? null },
    { field: "Trainer", platform: h.trainer, feed: e.trainer ?? null },
  ];
}

function Cell({ value, className }: { value: string | number | null; className: string }) {
  const blank = value === null || value === undefined || value === "";
  return (
    <td className={blank ? `${className} rm-blank` : className}>{blank ? "Not recorded" : value}</td>
  );
}

function ProposalCard({
  proposal,
  busy,
  onResolve,
}: {
  proposal: MatchProposal;
  busy: boolean;
  onResolve: (id: string, action: "confirm" | "reject") => void;
}) {
  const rows = buildRows(proposal);
  const agreeing = rows.filter((r) => valuesAgree(r.platform, r.feed)).length;
  const name = proposal.horse.racingName ?? proposal.horse.displayName;

  return (
    <article className="rm-card" data-testid="match-card">
      <div className="rm-card-head">
        <div>
          <h2>{name}</h2>
          <div className="rm-sub">
            {proposal.horse.racingName && proposal.horse.racingName !== proposal.horse.displayName
              ? `Also known as ${proposal.horse.displayName}`
              : "Proposed feed match awaiting review"}
          </div>
        </div>
        <div className="rm-head-meta">
          <span className={agreeing === rows.length ? "rm-pill green" : "rm-pill amber"}>
            {agreeing}/{rows.length} fields agree
          </span>
          <span className="rm-pill mono" title="Racing feed identifier">
            {proposal.racingApiId}
          </span>
        </div>
      </div>

      <table className="rm-compare">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">StablePass</th>
            <th scope="col" className="rm-feed-col">
              Racing feed
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const agrees = valuesAgree(r.platform, r.feed);
            return (
              <tr key={r.field} className={agrees ? undefined : "rm-row-diff"}>
                <th scope="row" className="rm-field">
                  {r.field}
                </th>
                <Cell value={r.platform} className="rm-value" />
                <Cell value={r.feed} className="rm-value rm-feed-col" />
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="rm-actions">
        <span className="rm-agree">
          Confirming links <strong>{name}</strong> to this feed id. Its races then appear
          automatically.
        </span>
        <div className="rm-buttons">
          <button
            type="button"
            className="btn rm-btn rm-btn-light"
            disabled={busy}
            onClick={() => onResolve(proposal.id, "reject")}
          >
            Reject
          </button>
          <button
            type="button"
            className="btn btn-primary rm-btn"
            disabled={busy}
            onClick={() => onResolve(proposal.id, "confirm")}
          >
            {busy ? "Saving…" : "Confirm match"}
          </button>
        </div>
      </div>
    </article>
  );
}

export default function MatchQueue({ initial }: { initial: MatchProposal[] }) {
  const [proposals, setProposals] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(id: string, action: "confirm" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/racing-matches/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not save that decision. Try again.");
        return;
      }
      setProposals((cur) => cur.filter((p) => p.id !== id));
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (proposals.length === 0) {
    return (
      <div className="rm-empty" data-testid="match-empty">
        <h2>No pending matches.</h2>
        <p>
          When the racing feed proposes a horse that looks like one of yours, it will appear here
          for review.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="match-queue">
      {error ? (
        <div className="rm-error" role="alert">
          {error}
        </div>
      ) : null}
      {proposals.map((p) => (
        <ProposalCard
          key={p.id}
          proposal={p}
          busy={busyId === p.id}
          onResolve={resolve}
        />
      ))}
    </div>
  );
}
