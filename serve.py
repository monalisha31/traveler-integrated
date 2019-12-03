#!/usr/bin/env python3
import argparse
import json
import asyncio
from enum import Enum
import uvicorn #pylint: disable=import-error
from fastapi import FastAPI, File, UploadFile, HTTPException #pylint: disable=import-error
from pydantic import BaseModel #pylint: disable=import-error
from starlette.staticfiles import StaticFiles #pylint: disable=import-error
from starlette.requests import Request #pylint: disable=import-error
from starlette.responses import RedirectResponse, StreamingResponse #pylint: disable=import-error
from database import Database
from clientLogger import ClientLogger

parser = argparse.ArgumentParser(description='Serve the traveler-integrated interface')
parser.add_argument('-d', '--db_dir', dest='dbDir', default='/tmp/traveler-integrated',
                    help='Directory where the bundled data is already / will be stored (default: /tmp/traveler-integrated)')
parser.add_argument('-s', '--debug', dest='debug', action='store_true',
                    help='Store additional information for debugging source files, etc.')

args = parser.parse_args()
db = Database(args.dbDir, args.debug)
app = FastAPI(
    title=__name__,
    description='This is a test',
    version='0.1.0'
)
app.mount('/static', StaticFiles(directory='static'), name='static')

def checkDatasetExistence(label):
    if label not in db:
        raise HTTPException(status_code=404, detail='Dataset not found')
def checkDatasetHasIntervals(label):
    if 'intervals' not in db[label] or 'intervalIndexes' not in db[label]:
        raise HTTPException(status_code=404, detail='Dataset does not contain indexed interval data')

def iterUploadFile(text):
    for line in text.decode().splitlines():
        yield line

@app.get('/')
def index():
    return RedirectResponse(url='/static/index.html')

@app.get('/datasets')
def list_datasets():
    return db.datasetList()

@app.get('/datasets/{label}')
def get_dataset(label: str):
    checkDatasetExistence(label)
    return db[label]['meta']
class BasicDataset(BaseModel):
    newick: str = None
    csv: str = None
    dot: str = None
    physl: str = None
    python: str = None
    cpp: str = None
@app.post('/datasets/{label}', status_code=201)
def create_dataset(label: str, dataset: BasicDataset = None):
    if label in db:
        raise HTTPException(status_code=409, detail='Dataset with label %s already exists' % label)
    logger = ClientLogger()
    async def startProcess():
        db.createDataset(label)
        if dataset:
            if dataset.newick:
                db.addSourceFile(label, label + '.newick', 'newick')
                await db.processNewickTree(label, dataset.newick, logger.log)
            if dataset.csv:
                db.addSourceFile(label, label + '.csv', 'csv')
                await db.processCsv(label, iter(dataset.csv.splitlines()), logger.log)
            if dataset.dot:
                db.addSourceFile(label, label + '.dot', 'dot')
                await db.processDot(label, iter(dataset.dot.splitlines()), logger.log)
            if dataset.physl:
                db.processCode(label, label + '.physl', dataset.physl.splitlines(), 'physl')
                await logger.log('Loaded physl code')
            if dataset.python:
                db.processCode(label, label + '.py', dataset.python.splitlines(), 'python')
                await logger.log('Loaded python code')
            if dataset.cpp:
                db.processCode(label, label + '.cpp', dataset.cpp.splitlines(), 'cpp')
                await logger.log('Loaded C++ code')
        await db.save(label, logger.log)
        logger.finish()
    return StreamingResponse(logger.iterate(startProcess), media_type='text/text')
@app.delete('/datasets/{label}')
def delete_dataset(label: str):
    db.purgeDataset(label)

class TreeSource(str, Enum):
    newick = 'newick'
    otf2 = 'otf2'
    graph = 'graph'
@app.get('/datasets/{label}/tree')
def get_tree(label: str, source: TreeSource = TreeSource.newick):
    checkDatasetExistence(label)
    if source not in db[label]['trees']:
        raise HTTPException(status_code=404, detail='Dataset does not contain %s tree data' % source.value)
    return db[label]['trees'][source]
@app.post('/datasets/{label}/tree')
def add_newick_tree(label: str, file: UploadFile = File(...)):
    checkDatasetExistence(label)
    logger = ClientLogger()
    async def startProcess():
        db.addSourceFile(label, file.filename, 'newick')
        await db.processNewickTree(label, (await file.read()).decode(), logger.log)
        await db.save(label, logger.log)
        logger.finish()
    return StreamingResponse(logger.iterate(startProcess), media_type='text/text')

@app.post('/datasets/{label}/csv')
def add_performance_csv(label: str, file: UploadFile = File(...)):
    checkDatasetExistence(label)
    logger = ClientLogger()
    async def startProcess():
        db.addSourceFile(label, file.filename, 'csv')
        await db.processCsv(label, iterUploadFile(await file.read()), logger.log)
        await db.save(label, logger.log)
        logger.finish()
    return StreamingResponse(logger.iterate(startProcess), media_type='text/text')

@app.post('/datasets/{label}/dot')
def add_dot_graph(label: str, file: UploadFile = File(...)):
    checkDatasetExistence(label)
    logger = ClientLogger()
    async def startProcess():
        db.addSourceFile(label, file.filename, 'dot')
        await db.processDot(label, iterUploadFile(await file.read()), logger.log)
        await db.save(label, logger.log)
        logger.finish()
    return StreamingResponse(logger.iterate(startProcess), media_type='text/text')

@app.post('/datasets/{label}/log')
def add_full_phylanx_log(label: str, file: UploadFile = File(...)):
    checkDatasetExistence(label)
    logger = ClientLogger()
    async def startProcess():
        db.addSourceFile(label, file.filename, 'log')
        await db.processPhylanxLog(label, iterUploadFile(await file.read()), logger.log)
        await db.save(label, logger.log)
        logger.finish()
    return StreamingResponse(logger.iterate(startProcess), media_type='text/text')

@app.post('/datasets/{label}/otf2')
async def add_otf2_trace(label: str, request: Request):
    # TODO: I think we can accept a raw stream instead of a otf2-print dump
    # (which would be a huge file):
    # async for chunk in request.stream()
    # ... but I'm not sure if this will even work with a linked Jupyter
    # approach, nor how to best map chunks to lines in db.processOtf2()
    raise HTTPException(status_code=501)

@app.get('/datasets/{label}/physl')
def get_physl(label: str):
    checkDatasetExistence(label)
    if 'physl' not in db[label]:
        raise HTTPException(status_code=404, detail='Dataset does not include physl source code')
    return db[label]['physl']
@app.post('/datasets/{label}/physl')
async def add_physl(label: str, file: UploadFile = File(...)):
    checkDatasetExistence(label)
    db.processCode(label, file.filename, iterUploadFile(await file.read()), 'physl')
    await db.save(label)
@app.get('/datasets/{label}/python')
def get_python(label: str):
    checkDatasetExistence(label)
    if 'python' not in db[label]:
        raise HTTPException(status_code=404, detail='Dataset does not include python source code')
    return db[label]['python']
@app.post('/datasets/{label}/python')
async def add_python(label: str, file: UploadFile = File(...)):
    checkDatasetExistence(label)
    db.processCode(label, file.filename, iterUploadFile(await file.read()), 'python')
    await db.save(label)
@app.get('/datasets/{label}/cpp')
def get_cpp(label: str):
    checkDatasetExistence(label)
    if 'cpp' not in db[label]:
        raise HTTPException(status_code=404, detail='Dataset does not include C++ source code')
    return db[label]['cpp']
@app.post('/datasets/{label}/cpp')
async def add_c_plus_plus(label: str, file: UploadFile = File(...)):
    checkDatasetExistence(label)
    db.processCode(label, file.filename, iterUploadFile(await file.read()), 'cpp')
    await db.save(label)

@app.get('/datasets/{label}/primitives')
def primitives(label: str):
    checkDatasetExistence(label)
    return dict(db[label]['primitives'])

class HistogramMode(str, Enum):
    utilization = 'utilization'
    count = 'count'
@app.get('/datasets/{label}/histogram')
def histogram(label: str, \
              mode: HistogramMode = HistogramMode.utilization, \
              bins: int = 100, \
              begin: float = None, \
              end: float = None, \
              location: str = None, \
              primitive: str = None):
    checkDatasetExistence(label)
    checkDatasetHasIntervals(label)

    if begin is None:
        begin = db[label]['meta']['intervalDomain'][0]
    if end is None:
        end = db[label]['meta']['intervalDomain'][1]

    def modeHelper(indexObj):
        # TODO: respond with a 204 when the histogram is empty
        # (d3.js doesn't have a good way to handle 204 error codes)
        # if indexObj.is_empty():
        #    raise HTTPException(status_code=204, detail='An index exists for the query, but it is empty')
        return getattr(indexObj, 'compute%sHistogram' % (mode.title()))(bins, begin, end)

    if location is not None:
        if location not in db[label]['intervalIndexes']['locations']:
            raise HTTPException(status_code=404, detail='No index for location: %s' % location)
        if primitive is not None:
            if primitive not in db[label]['intervalIndexes']['both'][location]:
                raise HTTPException(status_code=404, detail='No index for location, primitive combination: %s, %s' % (location, primitive))
            return modeHelper(db[label]['intervalIndexes']['both'][location][primitive])
        return modeHelper(db[label]['intervalIndexes']['locations'][location])
    if primitive is not None:
        if primitive not in db[label]['intervalIndexes']['primitives']:
            raise HTTPException(status_code=404, detail='No index for primitive: %s' % primitive)
        return modeHelper(db[label]['intervalIndexes']['primitives'][primitive])
    return modeHelper(db[label]['intervalIndexes']['main'])

@app.get('/datasets/{label}/intervals')
def intervals(label: str, begin: float = None, end: float = None):
    checkDatasetExistence(label)
    checkDatasetHasIntervals(label)

    if begin is None:
        begin = db[label]['meta']['intervalDomain'][0]
    if end is None:
        end = db[label]['meta']['intervalDomain'][1]

    def intervalGenerator():
        yield '['
        firstItem = True
        for i in db[label]['intervalIndexes']['main'].iterOverlap(begin, end):
            if not firstItem:
                yield ','
            yield json.dumps(db[label]['intervals'][i.data])
            firstItem = False
        yield ']'
    return StreamingResponse(intervalGenerator(), media_type='application/json')

@app.get('/datasets/{label}/intervals/{intervalId}/Trace')
def intervalTrace(label: str, intervalId: str, begin: float = None, end: float = None):
    # This streams back a list of string IDs, as well as two special metadata
    # objects for drawing lines to the left and right of the queried range when
    # the full traceback is not requested
    checkDatasetExistence(label)
    checkDatasetHasIntervals(label)

    if begin is None:
        begin = db[label]['meta']['intervalDomain'][0]
    if end is None:
        end = db[label]['meta']['intervalDomain'][1]

    def intervalIdGenerator():
        yield '['
        targetInterval = intervalObj = oneBeyondRight = db[label]['itervals'][intervalId]

        while intervalObj is not None:
            # Until we yield the first interval, keep track of whatever to its
            # right, beyond the queried window
            if oneBeyondRight is not None and intervalObj['enter']['Timestamp'] <= end:
                if oneBeyondRight == targetInterval:
                    # The target interval is within the queried window; we can just send
                    # that ID back directly instead of metadata
                    yield '"%s"' % targetInterval['intervalId']
                else:
                    # Before sending the first interval within the queried
                    # window, yield some metadata about the interval beyond the
                    # end boundary, so the client can draw lines beyond the
                    # window (and won't need access to the interval beyond the
                    # window itself)
                    yield json.dumps({
                        'type': 'beyondRight',
                        'id': oneBeyondRight['intervalId'],
                        'location': oneBeyondRight['Location'],
                        'beginTimestamp': oneBeyondRight['enter']['Timestamp']
                    })
                # Don't track whatever is to the right anymore
                oneBeyondRight = None

            # Yield the current interval (corner case: if it's the same as the
            # target interval, don't yield it twice)
            if intervalObj != targetInterval:
                yield ',"%s"' % intervalObj['intervalId']

            # Point oneBeyondRight to the current interval if we haven't found
            # one in the queried range yet, and shift intervalObj to its parent
            if 'lastParentInterval' in intervalObj:
                if oneBeyondRight is not None:
                    oneBeyondRight = intervalObj
                prevId = intervalObj['lastParentInterval']['id']
                intervalObj = db[label]['intervals'][prevId]

                # Stop yielding intervals if we went to the left of the queried
                # range
                if intervalObj['leave']['Timestamp'] < begin:
                    break
            else:
                # We reached the beginning of the dataset; nothing left to yield
                intervalObj = None

        # If there's one last interval to the left, beyond the begin boundary,
        # yield its metadata for beyond-the-scope drawing
        if intervalObj is not None and 'lastParentInterval' in intervalObj:
            yield ',' + json.dumps({
                'type': 'beyondLeft',
                'id': intervalObj['lastParentInterval']['id'],
                'location': intervalObj['lastParentInterval']['location'],
                'endTimestamp': intervalObj['lastParentInterval']['endTimestamp']
            })
            yield ',"%s"' % intervalObj['intervalId']

        yield ']'
    return StreamingResponse(intervalIdGenerator(), media_type='application/json')

if __name__ == '__main__':
    asyncio.get_event_loop().run_until_complete(db.load())
    uvicorn.run(app, host='0.0.0.0')
