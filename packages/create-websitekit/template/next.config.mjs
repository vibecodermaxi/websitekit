/** @type {import('next').NextConfig} */
export default {
  // @websitekit/* publish TypeScript source rather than a build artefact, so Next has to compile them
  // like first-party code. Without this a published install fails at build with a syntax error in
  // node_modules, which is an unhelpful place to meet your first websitekit problem.
  transpilePackages: ['@websitekit/sdk', '@websitekit/react'],
};
