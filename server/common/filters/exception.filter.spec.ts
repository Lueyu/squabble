import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ArgumentsHost } from '@nestjs/common';
import { ConflictException,HttpException,ServiceUnavailableException } from '@nestjs/common';
import { GlobalExceptionFilter } from './exception.filter';
async function filteredHttp(exception:unknown){
  const app=express(),filter=new GlobalExceptionFilter();
  app.get('/',(_request,response)=>filter.catch(exception,{switchToHttp:()=>({getResponse:()=>response})} as ArgumentsHost));
  const server=app.listen(0,'127.0.0.1');
  try{
    await once(server,'listening');
    const response=await fetch('http://127.0.0.1:'+(server.address() as AddressInfo).port+'/');
    return {status:response.status,body:await response.json() as {error:Record<string,unknown>}};
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
test('HTTP team conflicts preserve stable code and bounded revision/field metadata while dropping arbitrary details',async()=>{
  const result=await filteredHttp(new HttpException({code:'TEAM_REVISION_CONFLICT',message:'Draft changed',actualRevision:7,field:'roles',roleId:'12345678-1234-4123-8123-123456789012',retryable:false,fieldErrors:{roles:['Reload the saved draft']},credential:'fixture-secret-token',details:{password:'fixture-secret-password'},plan:{privateText:'fixture-private-body'}},409));
  assert.equal(result.status,409);assert.equal(result.body.error.code,'TEAM_REVISION_CONFLICT');
  assert.equal(result.body.error.actualRevision,7);assert.equal(result.body.error.field,'roles');
  assert.deepEqual(result.body.error.fieldErrors,{roles:['Reload the saved draft']});
  assert.equal(result.body.error.retryable,false);
  assert.equal(JSON.stringify(result.body).includes('fixture-secret'),false);
  assert.equal(JSON.stringify(result.body).includes('fixture-private'),false);
});
test('HTTP Nest string team errors and temporary dependency errors retain their exact code',async()=>{
  const conflict=await filteredHttp(new ConflictException('TEAM_SCOPE_REVOKED'));
  assert.equal(conflict.body.error.code,'TEAM_SCOPE_REVOKED');
  const temporary=await filteredHttp(new ServiceUnavailableException({code:'TEAM_DEPENDENCY_UNAVAILABLE',message:'Connection is temporarily unavailable',retryable:true,arbitrary:'fixture-secret'}));
  assert.equal(temporary.status,503);assert.equal(temporary.body.error.code,'TEAM_DEPENDENCY_UNAVAILABLE');assert.equal(temporary.body.error.retryable,true);
  assert.equal(JSON.stringify(temporary.body).includes('fixture-secret'),false);
});
test('HTTP unknown codes cannot impersonate team errors and unexpected 500 errors never expose internal causes',async()=>{
  const invalid=await filteredHttp(new HttpException({code:'CUSTOM_SECRET_CODE',message:'Invalid input',details:'fixture-secret'},400));
  assert.equal(invalid.body.error.code,'BAD_REQUEST');assert.equal(JSON.stringify(invalid.body).includes('fixture-secret'),false);
  for(const exception of [Object.assign(new Error('fixture-secret-stack'),{cause:'fixture-secret-cause'}),new HttpException({code:'CUSTOM_SECRET_CODE',message:'fixture-secret-internal',details:'fixture-secret-details'},500)]){
    const result=await filteredHttp(exception);assert.equal(result.status,500);assert.equal(result.body.error.code,'INTERNAL_ERROR');assert.equal(JSON.stringify(result.body).includes('fixture-secret'),false);
    assert.equal(result.body.error.stack,undefined);assert.equal(result.body.error.cause,undefined);
  }
});
test('HTTP legacy 4xx status, message and standard Nest details stay readable without copying arbitrary body fields',async()=>{
  const result=await filteredHttp(new ConflictException('LEGACY_REVISION_CHANGED'));
  assert.equal(result.status,409);assert.equal(result.body.error.code,'CONFLICT');assert.equal(result.body.error.message,'LEGACY_REVISION_CHANGED');
  assert.deepEqual(JSON.parse(String(result.body.error.details)),{statusCode:409,error:'Conflict',message:'LEGACY_REVISION_CHANGED'});
});
