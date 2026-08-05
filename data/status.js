/* Kerala Rain Holiday Watch — findings data
 *
 * This file is REWRITTEN by the research agent on each check.
 * Nothing here is inferred by the app: every `confirmed` district must
 * carry at least one source with a timestamp. See README.md for the schema.
 *
 * Loaded as a plain script (not fetched) so the app works from file://
 * without a local server.
 */
window.KERALA_STATUS = {
  "forDate": "2026-08-06",
  "forDateLabel": "Thursday, 06 August 2026",
  "checkedAt": "2026-08-05T19:51:18.960892+05:30",
  "headline": "Partial/conditional closures in 2 districts. No district-wide holiday declared.",
  "advisories": [
    {
      "level": "warn",
      "title": "Announcements may still be issued tonight",
      "body": "Individual District Collectors continue to review local conditions. Remaining districts under rain warnings may still issue closure orders later tonight."
    }
  ],
  "weather": {
    "summary": "Orange alert in force across multiple districts. Heavy to very heavy rainfall expected in isolated areas.",
    "outlook": "IMD forecast predicts continued rain statewide.",
    "impact": "High risk of waterlogging and localized flooding. Relief camps active.",
    "source": {
      "name": "Onmanorama",
      "url": "https://www.onmanorama.com/news/kerala/2026/08/05/kerala-rain-orange-alert-yellow-red-holiday-educational-institutions-live.html"
    }
  },
  "districts": [
    {
      "name": "Thiruvananthapuram",
      "status": "none",
      "alert": "yellow",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Kollam",
      "status": "none",
      "alert": "yellow",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Pathanamthitta",
      "status": "confirmed",
      "alert": "orange",
      "confidence": 60,
      "scope": "Thiruvalla taluk only",
      "appliesTo": "All educational institutions in Thiruvalla taluk. Elsewhere in the district, only schools functioning as relief camps are closed.",
      "excludes": "Institutions outside the named taluks that are not relief camps.",
      "reason": "Adverse weather and heavy rainfall",
      "declaredBy": "District Collector, Pathanamthitta",
      "exams": "Scheduled public and university examinations proceed unless specified.",
      "confidenceNote": "Reported by Onmanorama.",
      "sources": [
        {
          "name": "Onmanorama",
          "title": "Holiday for educational institutions in Thiruvalla tomorrow, relief camp schools to remain shut in 2 districts",
          "url": "https://www.onmanorama.com/news/kerala/2026/08/05/kerala-rain-schools-relief-camps-educational-institutions-holiday.html",
          "time": "Latest Update",
          "tier": 1
        }
      ]
    },
    {
      "name": "Alappuzha",
      "status": "none",
      "alert": "orange",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Kottayam",
      "status": "none",
      "alert": "orange",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Idukki",
      "status": "none",
      "alert": "orange",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Ernakulam",
      "status": "none",
      "alert": "orange",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Thrissur",
      "status": "none",
      "alert": "yellow",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Palakkad",
      "status": "none",
      "alert": "yellow",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Malappuram",
      "status": "none",
      "alert": "yellow",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Kozhikode",
      "status": "none",
      "alert": "orange",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Wayanad",
      "status": "confirmed",
      "alert": "orange",
      "confidence": 60,
      "scope": "Relief camp schools only",
      "appliesTo": "All schools functioning as relief camps",
      "excludes": "All other educational institutions",
      "reason": "Schools serving as relief camps during floods",
      "declaredBy": "District Collector, Wayanad",
      "exams": "Scheduled public and university examinations proceed unless specified.",
      "confidenceNote": "Reported by Onmanorama.",
      "sources": [
        {
          "name": "Onmanorama",
          "title": "Holiday for educational institutions in Thiruvalla tomorrow, relief camp schools to remain shut in 2 districts",
          "url": "https://www.onmanorama.com/news/kerala/2026/08/05/kerala-rain-schools-relief-camps-educational-institutions-holiday.html",
          "time": "Latest Update",
          "tier": 1
        }
      ]
    },
    {
      "name": "Kannur",
      "status": "none",
      "alert": "orange",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    },
    {
      "name": "Kasaragod",
      "status": "none",
      "alert": "orange",
      "confidence": null,
      "scope": null,
      "appliesTo": null,
      "excludes": null,
      "reason": null,
      "declaredBy": null,
      "exams": null,
      "confidenceNote": null,
      "sources": []
    }
  ],
  "debunked": [],
  "limitations": [
    "Parsed automatically from news media reports. Verify with local administrative announcements."
  ]
};
