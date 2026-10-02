type Destination = 'cauldron' | 'saved' | 'planner'

interface Props {
  onNavigate: (tab: Destination) => void
}

export function HomePage({ onNavigate }: Props) {
  return (
    <div className="page home">
      <section className="panel home-intro">
        <h2>Plan Alchemy Factory production chains around your own cauldron recipes</h2>
        <p>
          Find cauldron mixes that make what you need, save the good ones, and use them as steps in a production plan
          alongside the game&apos;s fixed recipes, nurseries, and purchases. The planner sizes every step in items/min
          and machine counts, and it handles chains that feed back into themselves.
        </p>
      </section>

      <section className="home-tabs">
        <article className="panel mode-normal">
          <h3>Cauldron</h3>
          <p>
            Mix ingredients to see what a combination makes (3 in a normal cauldron, 2 in an advanced one), or pick a
            target and list every mix that makes it. Mark ingredients as preferred or avoided to narrow the results.
            Star a recipe to save it.
          </p>
          <button onClick={() => onNavigate('cauldron')}>Open Cauldron</button>
        </article>
        <article className="panel mode-normal">
          <h3>Saved recipes</h3>
          <p>
            Your starred mixes, in a table. Name them and keep notes; each one becomes a producer you can pick in the
            planner.
          </p>
          <button onClick={() => onNavigate('saved')}>Open Saved recipes</button>
        </article>
        <article className="panel mode-normal">
          <h3>Planner</h3>
          <p>
            Set targets in items/min and the planner works back through every ingredient to the rate and machine count
            each step needs, shown as a foldable tree. Pick how each item is produced. If a chain can&apos;t be met, the
            planner reports the shortfall where it happens.
          </p>
          <button onClick={() => onNavigate('planner')}>Open Planner</button>
        </article>
      </section>

      <section className="panel">
        <h2>How it fits together</h2>
        <ol className="home-steps">
          <li>
            <strong>Find a recipe.</strong> On the Cauldron tab, search for mixes that make the item you want. Star the
            ones worth keeping.
          </li>
          <li>
            <strong>Use it in a plan.</strong> In the Planner&apos;s production tree, open the producer menu on a row of
            the item and pick your saved recipe (★).
          </li>
          <li>
            <strong>Size the chain.</strong> In the Planner, set target rates, choose producers for the ingredients, and
            enter your upgrade levels. Read machine counts and raw inputs off the tree.
          </li>
          <li>
            <strong>Repeat.</strong> The Cauldron finder can prefer ingredients your active plan already makes or has
            left over, so new recipes can build on what the plan already produces.
          </li>
        </ol>
        <p className="hint">
          Saved recipes and plans are stored in this browser only. Use Export to download a backup and Import to restore
          it or move it to another browser.
        </p>
      </section>
    </div>
  )
}
