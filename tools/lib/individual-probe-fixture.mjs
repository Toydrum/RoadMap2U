/** Isolate only this browser probe's adult from the mock's legacy family seed.
 * No payment evidence, users, relationships or real service data are changed. */
export async function isolateIndividualBillingFixture(page) {
  const url = new URL(page.url());
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password)
    throw new Error('LOCAL_INDIVIDUAL_FIXTURE_REQUIRED');
  return page.evaluate(() => new Promise((resolve, reject) => {
    let identity;
    try {
      const parts = (localStorage.getItem('rm2u.mock.idToken') ?? '').split('.');
      if (parts.length !== 3 || parts[2] !== 'mock') throw new Error();
      identity = JSON.parse(atob(parts[1]));
      if (typeof identity.sub !== 'string' || !identity.sub || typeof identity.accountInstanceId !== 'string' || !identity.accountInstanceId) throw new Error();
    } catch { reject(new Error('CURRENT_SYNTHETIC_ADULT_REQUIRED')); return; }
    const open = indexedDB.open('roadmap2u-mockcloud');
    open.onupgradeneeded = () => { open.transaction.abort(); reject(new Error('CURRENT_SYNTHETIC_ADULT_REQUIRED')); };
    open.onerror = () => reject(new Error('SYNTHETIC_FIXTURE_FAILED'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(['users', 'coverages'], 'readwrite');
      let invalid;
      const read = tx.objectStore('users').get(identity.sub);
      read.onsuccess = () => {
        const owner = read.result;
        if (owner?.userId !== identity.sub || owner.accountType !== 'adult' || owner.accountInstanceId !== identity.accountInstanceId) {
          invalid = new Error('CURRENT_SYNTHETIC_ADULT_REQUIRED'); tx.abort(); return;
        }
        tx.objectStore('coverages').delete(owner.userId);
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(invalid ?? new Error('SYNTHETIC_FIXTURE_FAILED')); };
    };
  }));
}
