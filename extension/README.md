# skillBNK Research Assistant (Chrome extension)

Takes the next lead from the CRM, asks ChatGPT inside the skillBNK project, shows you the answer to review, and saves it to the CRM in one click.
It prepares drafts only. It never sends a message, email or form, and it never clicks anything on LinkedIn.

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
