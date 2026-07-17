import unittest

import validate_atlas
from frontmatter import FrontmatterError, parse_document, parse_frontmatter


class FrontmatterConformanceTests(unittest.TestCase):
    def test_all_conformance_fixtures(self):
        errors, count = validate_atlas.run_conformance()
        self.assertGreaterEqual(count, 40)
        self.assertEqual([], errors)

    def test_fenceless_plan_document(self):
        data = (
            b"id: plan:example\n"
            b"title: Example\n"
            b"directions: []\n"
            b"concepts: []\n"
        )
        self.assertEqual(
            {
                "id": "plan:example",
                "title": "Example",
                "directions": [],
                "concepts": [],
            },
            parse_document(data, "plan.yaml"),
        )

    def test_rejection_is_deterministic_and_names_line(self):
        data = b"---\nvalue: first\nvalue: second\n---\n"
        messages = []
        for _ in range(2):
            with self.assertRaises(FrontmatterError) as raised:
                parse_frontmatter(data, "duplicate.md")
            messages.append(str(raised.exception))
        self.assertEqual(messages[0], messages[1])
        self.assertIn("duplicate.md: frontmatter line 3", messages[0])
        self.assertIn("duplicate key", messages[0])


if __name__ == "__main__":
    unittest.main()
