# skillBNK Research Assistant (Chrome extension)

Takes the next lead from the CRM, asks ChatGPT inside the skillBNK project, shows you the answer to review, and saves it to the CRM in one click.
It prepares drafts. It never sends a message, email or form by itself. Since 0.17.0 there is one exception you control: the **Do it on LinkedIn** buttons (below) act on LinkedIn only when you press one for that lead.

## Install (once)
1. Chrome > `chrome://extensions` > turn on **Developer mode** > **Load unpacked** > choose this `extension` folder.
2. Click the extension icon to open the side panel > **Settings**.
3. Make an API key in the CRM (your account's API keys) and paste it. Paste the link of your ChatGPT **skillBNK project page**.
4. Press **Copy master prompt** and paste it into the project's instructions once. If the box says it is too long, save it as a .txt file and upload it to the project files, with a short instruction to follow it.
5. Sign in to ChatGPT in the same Chrome.

## Daily use
1. **Load leads** (To research, My leads, or another list).
2. Optional per lead: open the lead's website and press **Scan open website** (finds booking links, Contact Us page, emails); open the LinkedIn profile or inbox and press **Read open LinkedIn page** (it only reads text you already have open).
3. **Research this lead**, or **Research all** to go through the list one by one with a pause between leads (a human-like pace).
4. Review the preview, edit anything, press **Save to CRM**. Then use the quick links (Gmail draft, profile, post, form) to do the human step yourself.
5. Send leads that qualified (PURSUE or QUALIFY) to the CEO from the lead panel in the CRM.

## Daily sweep (one look instead of every lead)
Press **Run daily sweep**. It reads the sent-invitations page, the LinkedIn messaging list and the webmail inbox, matches them to your leads, and marks leads that changed (accepted, new message, new email) as "needs review". Then choose **Changed since last check** and press Load leads: only those leads go to ChatGPT, in their own saved chat, with just what is new.

## Automatic check per lead (Settings > "Check website, LinkedIn, webmail")
Before asking ChatGPT, the extension reads: up to 4 pages of the lead's website (booking links, Contact Us page, platform and payment links, emails), the LinkedIn profile (1st, 2nd or 3rd degree), the message thread when the lead is a 1st-degree connection, and a webmail search for the lead (who wrote last). It pauses between pages like a person. What it cannot read is reported as "not checked", never guessed. **Check only** runs just this step so you can see what it found.

## If something breaks
ChatGPT changes its page now and then. If the message box or Send button is not found, only `chatgpt.js` needs a small fix.

## Do it on LinkedIn (v0.17.0, you press each button)
Open **Do it on LinkedIn** under any lead. Nothing runs by itself, every action is for that one lead, and the CRM is written to only when the LinkedIn page proves it happened.
- **Fit check**: reads the profile and company page (read-only). Shows the degree, whether an invite is already pending, whether the profile shows Michigan, the role, the company size from LinkedIn and whether the size and authority rules say likely SKIP.
- **Connect with note**: 1) **Check profile** (confirms Michigan and that no invite is pending or accepted). 2) Type one real fact and one curious question; the note is built as "Hi <first>, I'm Shiblu, a fellow Michigander and founder based in Warren. I saw <fact>. <question> Glad to connect." and checked live: 300 characters or fewer, one question, no offer or meeting words, no emoji, no dashes, no signature, and "fellow Michigander" only if the profile shows Michigan. 3) **Send invitation** asks you to confirm the exact text, sends it, then looks for it on the Sent invitations page. Only then it logs "linkedin_connect".
- **Like latest post**: likes the lead's own post from the last month, only if it is not liked yet; logs "linkedin_like" after the page shows it is liked. Old posts are never liked.
- **Follow**: follows from the profile top card; logs "linkedin_follow" after the page shows Following or the follower count rises. (LinkedIn already follows some profiles when an invite is sent.)
- Daily safety limits: 25 invites, 60 likes, 40 follows. They are a brake, not a target.
- If LinkedIn changes its page and a button stops working, nothing is logged and the panel says what it could not find. The page code is in `actions.js` (`pageActLike`, `pageActFollow`, `pageActInvite`, `pageActSentCheck`).
- The rule checker has unit tests: `node --test test/actions.test.js`.
