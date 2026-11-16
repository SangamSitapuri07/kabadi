import { GoogleSignIn } from './google-sign-in';

export default function Home() {
  return (
    <main className="page">
      <div className="brand"><span aria-hidden="true">♻</span> Kabadiwala Connect</div>
      <section className="intro" aria-labelledby="welcome">
        <p className="eyebrow">A BETTER WAY TO RECYCLE</p>
        <h1 id="welcome">Give your scrap a <span>new beginning.</span></h1>
        <p className="description">
          We&apos;re building a simpler way for customers and local scrap collectors to connect.
        </p>
        <GoogleSignIn />
        <div className="notice">
          <span className="dot" aria-hidden="true" />
          <p><strong>Under development</strong><br />Collection requests aren&apos;t available yet.</p>
        </div>
      </section>
      <footer>Thoughtfully built for a more circular future. <a href="/api/v1/health/live">API process liveness</a> (not marketplace readiness).</footer>
    </main>
  );
}
