import { useState } from "react";
import { Runs } from "./components/Runs";
import { Playground } from "./components/Playground";

type Tab = "runs" | "playground";

export function App() {
  const [tab, setTab] = useState<Tab>("runs");

  return (
    <>
      <header>
        <h1>
          <span className="tag">autobench</span> — local voice/chat pipeline lab
        </h1>
        <nav className="tabs">
          <button
            className={tab === "runs" ? "tab-active" : ""}
            onClick={() => setTab("runs")}
          >
            runs
          </button>
          <button
            className={tab === "playground" ? "tab-active" : ""}
            onClick={() => setTab("playground")}
          >
            playground
          </button>
        </nav>
      </header>
      <main>{tab === "runs" ? <Runs /> : <Playground />}</main>
    </>
  );
}
