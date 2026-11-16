const {test}=require('node:test');
const assert=require('node:assert/strict');
const fixture=require('./simple-test-loader.cjs');
test('explicit canvas wins over narrow default and survives query serialization',()=>{
 const {teamEditorView,withTeamEditorView}=fixture().load('features/teams/team-editor-navigation.ts');
 assert.equal(teamEditorView(new URLSearchParams('panel=organization'),390),'list');
 const next=withTeamEditorView(new URLSearchParams('panel=organization'),'canvas');
 assert.equal(teamEditorView(new URLSearchParams(next.toString()),390),'canvas');
 assert.equal(next.get('panel'),'organization');
});
test('configuration errors remain in organization while relation errors go to relations',()=>{
 const {teamIssueDestination}=fixture().load('features/teams/team-editor-navigation.ts');
 assert.equal(teamIssueDestination({code:'ROLE_CONFIGURATION',objectIds:['r']}),'organization');
 assert.equal(teamIssueDestination({code:'MISSING_DEPARTMENT',objectIds:['d']}),'organization');
 assert.equal(teamIssueDestination({code:'REPORTING_CYCLE',objectIds:['r']}),'relations');
});
